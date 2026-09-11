/**
 * latency.js — voice round-trip timing (dev diagnostic).
 *
 * Measures the full "press mic → hear the reply" pipeline and logs a
 * per-stage breakdown to the browser console. Gated by
 * general.debug_latency in settings.yaml (loaded into debugLatencyEnabled
 * by app.js / gen-settings.js); every method here is a no-op while the
 * flag is off.
 *
 * The pipeline spans three independent HTTP requests orchestrated by the
 * browser (POST /api/stt → POST /api/chat SSE → POST /api/tts), so the
 * frontend is the only place the end-to-end number can be measured. The
 * STT and TTS proxies also log their own upstream call durations
 * server-side when the same flag is on.
 *
 * Timeline of marks (ms are measured from t0):
 *   t0            mic stop (voice) or send click (typed) — the start
 *   sttDone       transcript received from /api/stt          (voice only)
 *   chatStart     POST /api/chat issued
 *   firstToken    first streamed token of the first reply
 *   chatComplete  SSE "complete" — all personas finished generating
 *   ttsFirstReq   first POST /api/tts issued
 *   ttsFirstAudio first synthesized audio starts playing
 *   ttsEnd        last audio finished; every TTS queue drained
 */

const latency = {
    active: false,
    source: null,      // "voice" | "text"
    t0: 0,
    marks: {},
    reported: false,
    chatDone: false,

    /**
     * Start a fresh measurement. Called when the mic stops (voice) or, for
     * a typed message, when the message is sent. A begin() while another
     * measurement is still open just replaces it.
     */
    begin(source) {
        if (!debugLatencyEnabled) return;
        this.active = true;
        this.source = source;
        this.t0 = performance.now();
        this.marks = {};
        this.reported = false;
        this.chatDone = false;
    },

    /** Abandon the current measurement (e.g. STT failed) without logging. */
    cancel() {
        this.active = false;
    },

    /**
     * Record a stage boundary. First write wins — repeat calls for the
     * same name are ignored, so "firstToken" stays the first token.
     */
    mark(name) {
        if (!this.active) return;
        if (this.marks[name] === undefined) {
            this.marks[name] = performance.now() - this.t0;
        }
    },

    /**
     * The chat SSE stream finished. TTS audio may still be fetching or
     * playing, so the report is deferred to maybeFinish().
     */
    chatComplete() {
        if (!this.active) return;
        this.mark("chatComplete");
        this.chatDone = true;
        this.maybeFinish();
    },

    /**
     * Emit the report once the chat stream is done AND every TTS queue is
     * idle. Safe to call from any pipeline stage's completion handler;
     * it only fires once.
     */
    maybeFinish() {
        if (!this.active || this.reported || !this.chatDone) return;
        const ttsIdle =
            audioQueue.length === 0 && !isPlayingAudio &&
            ttsRequestQueue.length === 0 && ttsReadyBuffers.size === 0 &&
            !isFetchingTTS && !isPlayingAudioBuffer &&
            (typeof sentenceBuffer !== "string" || sentenceBuffer === "");
        if (!ttsIdle) return;
        this.mark("ttsEnd");
        this._report();
    },

    _report() {
        this.reported = true;
        this.active = false;
        const m = this.marks;
        const total = m.ttsEnd ?? m.chatComplete ?? 0;
        const ms = (v) => (v === undefined ? "     —  " : `${v.toFixed(0).padStart(5)} ms`);
        const seg = (from, to) =>
            (m[from] !== undefined && m[to] !== undefined) ? ms(m[to] - m[from]) : "     —  ";

        const startLabel = this.source === "voice" ? "mic stop" : "send";
        const lines = [
            `%c[latency]%c ${this.source} round-trip: ${total.toFixed(0)} ms   (start = ${startLabel})`,
            `  STT transcription        ${this.source === "voice" ? ms(m.sttDone) : "  (typed) "}`,
            `  → LLM first token        ${seg("chatStart", "firstToken")}`,
            `  LLM token streaming      ${seg("firstToken", "chatComplete")}`,
            `  first TTS audio playing  ${ms(m.ttsFirstAudio)}   (from start)`,
            `  TTS synth (1st sentence) ${seg("ttsFirstReq", "ttsFirstAudio")}`,
            `  TTS tail after LLM done  ${seg("chatComplete", "ttsEnd")}`,
        ];
        console.info(lines.join("\n"), "color:#3b82f6;font-weight:bold", "color:inherit");
        console.debug("[latency] raw marks (ms from start):", { ...m });
    },
};

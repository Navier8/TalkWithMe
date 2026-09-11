/**
 * gen-settings.js — General Settings modal: load and persist app-level config.
 *
 * Handles max_persona_replies and persona_name_mentions through the general
 * settings overlay. Reads/writes via the existing /api/settings endpoint.
 */

/* ==========================================================================
   Event listeners
   ========================================================================== */

document.getElementById("btn-gen-settings").addEventListener("click", openGenSettings);
document.getElementById("gen-settings-btn-close").addEventListener("click", closeGenSettings);
document.getElementById("gen-settings-btn-cancel").addEventListener("click", closeGenSettings);
genSettingsForm.addEventListener("submit", submitGenSettings);

genSettingsOverlay.addEventListener("click", (e) => {
    if (e.target === genSettingsOverlay) closeGenSettings();
});

/* ==========================================================================
   Modal lifecycle
   ========================================================================== */

async function openGenSettings() {
    genSettingsOverlay.classList.remove("hidden");
    genSettingsError.classList.add("hidden");

    const saveBtn = document.getElementById("gen-settings-btn-save");
    saveBtn.disabled = true;

    const ok = await loadGenSettingsIntoForm();
    saveBtn.disabled = !ok;
}

function closeGenSettings() {
    genSettingsOverlay.classList.add("hidden");
}

/* ==========================================================================
   Form population
   ========================================================================== */

async function loadGenSettingsIntoForm() {
    try {
        const resp = await fetch("/api/settings");
        if (!resp.ok) {
            showGenSettingsError(`Failed to load settings (HTTP ${resp.status}).`);
            return false;
        }
        const data = await resp.json();
        gsfMaxPersonaReplies.value = data.general.max_persona_replies ?? 1;
        gsfPersonaNameMentions.checked = data.general.persona_name_mentions ?? true;
        gsfMaxTurnsForContext.value = data.general.max_turns_for_context ?? 6;
        gsfShowToolCalls.checked = data.general.show_tool_calls ?? true;
        gsfEnablePersonaMemories.checked = data.general.enable_persona_memories ?? true;
        gsfGlobalSystemPrompt.value = data.general.global_system_prompt ?? "";
        gsfDebugLatency.checked = data.general.debug_latency ?? false;
        gsfVoiceActivation.checked = data.general.voice_activation ?? false;
        gsfVadSensitivity.value = data.general.vad_sensitivity ?? 3;
        gsfVadSilenceMs.value = data.general.vad_silence_ms ?? 900;
        return true;
    } catch (err) {
        console.error("Failed to load settings:", err);
        showGenSettingsError("Failed to load settings. Is the server running?");
        return false;
    }
}

function showGenSettingsError(msg) {
    genSettingsError.textContent = msg;
    genSettingsError.classList.remove("hidden");
}

/* ==========================================================================
   Form submission
   ========================================================================== */

async function submitGenSettings(e) {
    e.preventDefault();
    genSettingsError.classList.add("hidden");

    const maxReplies = parseInt(gsfMaxPersonaReplies.value, 10);
    if (isNaN(maxReplies) || maxReplies < 1 || maxReplies > 4) {
        return showGenSettingsError("Max Persona Replies must be between 1 and 4.");
    }

    const maxTurns = parseInt(gsfMaxTurnsForContext.value, 10);
    if (isNaN(maxTurns) || maxTurns < 1 || maxTurns > 50) {
        return showGenSettingsError("Max Turns for Context must be between 1 and 50.");
    }

    const sensitivity = parseInt(gsfVadSensitivity.value, 10);
    if (isNaN(sensitivity) || sensitivity < 1 || sensitivity > 5) {
        return showGenSettingsError("Microphone Sensitivity must be between 1 and 5.");
    }

    const silenceMs = parseInt(gsfVadSilenceMs.value, 10);
    if (isNaN(silenceMs) || silenceMs < 300 || silenceMs > 3000) {
        return showGenSettingsError("End-of-Speech Silence must be between 300 and 3000 ms.");
    }

    // Fetch current full settings so we can patch only the general section
    let current;
    try {
        const resp = await fetch("/api/settings");
        if (!resp.ok) return showGenSettingsError(`Failed to load current settings (HTTP ${resp.status}).`);
        current = await resp.json();
    } catch (err) {
        return showGenSettingsError("Failed to load current settings.");
    }

    const payload = {
        ...current,
        // Restore null seed as 0 (API contract: 0 means no seed)
        tts: { ...current.tts, base_url: current.tts.base_url ?? "", seed: current.tts.seed ?? 0 },
        stt: { ...current.stt, base_url: current.stt.base_url ?? "" },
        general: {
            persona_name_mentions: gsfPersonaNameMentions.checked,
            max_persona_replies: maxReplies,
            max_turns_for_context: maxTurns,
            show_tool_calls: gsfShowToolCalls.checked,
            enable_persona_memories: gsfEnablePersonaMemories.checked,
            // Always sent (even blank): the general section is a partial
            // update, so an omitted field would keep the old value and a
            // cleared textarea could never actually clear the prompt.
            global_system_prompt: gsfGlobalSystemPrompt.value,
            debug_latency: gsfDebugLatency.checked,
            voice_activation: gsfVoiceActivation.checked,
            vad_sensitivity: sensitivity,
            vad_silence_ms: silenceMs,
        },
    };

    try {
        const resp = await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            return showGenSettingsError(extractApiErrorMessage(err, resp.status));
        }

        // Sync in-memory state (forgetting one of these lets the next
        // settings save from another dialog persist a stale value)
        personaNameMentionsEnabled = gsfPersonaNameMentions.checked;
        maxPersonaReplies = maxReplies;
        maxTurnsForContext = maxTurns;
        debugLatencyEnabled = gsfDebugLatency.checked;
        voiceActivationEnabled = gsfVoiceActivation.checked;
        vadSensitivity = sensitivity;
        vadSilenceMs = silenceMs;
        // Re-arm a running detector with the new thresholds, and follow the
        // checkbox: saving the setting is how the user expects to turn
        // hands-free on and off for good, not just for this page load.
        applyVoiceSettings();
        if (voiceActivationEnabled && !handsFreeEnabled) {
            // The Save click is the user gesture that lets the audio
            // context start; a failure here is reported, not swallowed.
            if (!await enableHandsFree()) {
                showGenSettingsError("Settings saved, but hands-free listening could not start — check microphone access.");
                return;
            }
        } else if (!voiceActivationEnabled && handsFreeEnabled) {
            disableHandsFree();
        }

        closeGenSettings();
    } catch (err) {
        console.error("Failed to save settings:", err);
        showGenSettingsError("Request failed. Is the server running?");
    }
}

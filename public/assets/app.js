/* InterviewCopilot Pro – client application.
 *
 * Audio sources for the "Interviewer Stream":
 *   1. Microphone  -> browser Web Speech API (Chrome / Edge), live interim text.
 *   2. Tab/meeting -> getDisplayMedia audio, voice-activity detection in the page,
 *                     each spoken segment transcribed by Gemini.
 *
 * Gemini is reached through the Netlify Function at /api/gemini (key stays on the
 * server), or directly from the browser if the user pastes their own key.
 */
(() => {
    'use strict';

    // ------------------------------------------------------------------ config
    const CONFIG = {
        model: 'gemini-3-flash-preview',
        directEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
        proxyEndpoint: '/api/gemini',
        storageKey: 'interviewCopilot.settings.v1',
        speechLang: 'en-US',
        // Tab-audio voice activity detection
        vadRmsThreshold: 0.008,      // RMS above this counts as speech (digital audio is very clean)
        segmentEndSilenceMs: 800,    // silence that closes a spoken segment
        minSpeechMs: 300,            // ignore blips shorter than this
        maxSegmentMs: 25000,         // force-close very long segments
        targetSampleRate: 16000,     // WAV sent to Gemini
    };

    const DEFAULTS = {
        track: 'technical',
        role: 'Senior Full-Stack Engineer',
        experience: '8+ YOE',
        context: 'Specialized in React, Node.js, Distributed Systems, Cloud Architecture & Scalable Web Apps.',
        customApiKey: '',
        accessCode: '',
        autoVAD: true,
        silenceMs: 3000,
        opacity: 95,
    };

    // ------------------------------------------------------------------- state
    const state = { ...DEFAULTS, ...loadSettings(), view: 'dashboard' };
    // Guard against hand-edited or corrupted saved settings.
    state.silenceMs = Math.min(7000, Math.max(1000, Math.round((Number(state.silenceMs) || 3000) / 1000) * 1000));
    state.opacity = Math.min(100, Math.max(30, Number(state.opacity) || 95));
    state.autoVAD = state.autoVAD !== false;
    ['track', 'role', 'experience', 'context', 'customApiKey', 'accessCode'].forEach((k) => {
        if (typeof state[k] !== 'string') state[k] = DEFAULTS[k];
    });
    if (!['technical', 'behavioral', 'system', 'custom'].includes(state.track)) state.track = DEFAULTS.track;

    const speech = {
        interviewer: { rec: null, base: '', skip: 0, len: 0 },
        candidate: { rec: null, base: '', skip: 0, len: 0 },
    };

    const rt = {
        interviewerListening: false,
        candidateRecording: false,
        generating: false,
        memory: [],           // [{ type, text, timestamp }]
        currentAnswer: null,
        silence: { interval: null, endAt: 0, remaining: 0, active: false },
        server: { checked: false, reachable: false, configured: false, accessCodeRequired: false, model: CONFIG.model },
        tab: {
            active: false, stream: null, ctx: null, node: null, mute: null, source: null,
            queue: Promise.resolve(), pending: 0, lastErrorToast: 0,
            seg: freshSegment(),
        },
    };

    function freshSegment() {
        return { inSpeech: false, chunks: [], preRoll: [], silentMs: 0, durationMs: 0, speechMs: 0, lastVoiceTs: 0 };
    }

    const $ = (id) => document.getElementById(id);
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

    // ---------------------------------------------------------------- utilities
    function loadSettings() {
        try { return JSON.parse(localStorage.getItem(CONFIG.storageKey)) || {}; } catch { return {}; }
    }

    function saveSettings() {
        const keys = Object.keys(DEFAULTS);
        const data = {};
        keys.forEach((k) => { data[k] = state[k]; });
        try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(data)); } catch { /* storage blocked */ }
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nowLabel = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const joinText = (a, b) => `${a || ''} ${b || ''}`.replace(/\s+/g, ' ').trim();

    function refreshIcons() {
        try { if (window.lucide) window.lucide.createIcons(); } catch { /* icons are cosmetic */ }
    }

    function toast(message, type = 'info', ms = 4000) {
        const root = $('toast-root');
        if (!root) return;
        const palette = {
            info: 'border-blue-500/40 text-blue-100',
            success: 'border-emerald-500/40 text-emerald-100',
            error: 'border-red-500/50 text-red-100',
        };
        const el = document.createElement('div');
        el.className = `px-3 py-2 rounded-lg bg-slate-900/95 border text-xs shadow-xl ${palette[type] || palette.info}`;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.textContent = message;
        root.appendChild(el);
        setTimeout(() => el.remove(), ms);
    }

    // ------------------------------------------------------- silence countdown
    function startSilenceCountdown(fromTs = Date.now()) {
        if (!state.autoVAD) return;
        stopCountdownInterval();
        const s = rt.silence;
        s.endAt = Math.max(fromTs + state.silenceMs, Date.now() + 300);
        s.remaining = Math.max(0, (s.endAt - Date.now()) / 1000);
        s.active = true;
        updateVADUI();
        s.interval = setInterval(() => {
            s.remaining = Math.max(0, (s.endAt - Date.now()) / 1000);
            if (s.remaining <= 0) {
                clearSilenceTimers();
                triggerAutoAnswer();
                return;
            }
            updateVADUI();
        }, 100);
    }

    function stopCountdownInterval() {
        if (rt.silence.interval) clearInterval(rt.silence.interval);
        rt.silence.interval = null;
    }

    function clearSilenceTimers() {
        const wasActive = rt.silence.active;
        stopCountdownInterval();
        rt.silence.active = false;
        rt.silence.remaining = state.silenceMs / 1000;
        if (wasActive) updateVADUI();
    }

    function updateVADUI() {
        const total = state.silenceMs / 1000;
        const s = rt.silence;
        const label = $('vad-timer-label');
        const bar = $('vad-progress-bar');
        const text = $('vad-countdown-text');

        if (s.active) {
            bar.style.width = `${clamp((1 - s.remaining / total) * 100, 0, 100)}%`;
            text.textContent = `${s.remaining.toFixed(1)}s`;
            label.textContent = `Auto in ${s.remaining.toFixed(1)}s`;
            label.classList.add('text-amber-400');
        } else {
            bar.style.width = '0%';
            text.textContent = `${total.toFixed(1)}s`;
            label.classList.remove('text-amber-400');
            if (!state.autoVAD) label.textContent = 'VAD Paused';
            else if (rt.interviewerListening) label.textContent = 'Silence Timer Active';
            else label.textContent = 'Silence Timer Idle';
        }
    }

    function applySilenceDelayUI() {
        const secs = state.silenceMs / 1000;
        $('silence-delay-val').textContent = `${secs} sec`;
        $('vad-badge').textContent = `Auto ${secs}s VAD`;
        $('welcome-delay').textContent = `${secs} second${secs === 1 ? '' : 's'}`;
        updateVADUI();
    }

    async function triggerAutoAnswer() {
        const question = $('question-input').value.trim();
        if (!question) return;
        if (rt.tab.pending > 0) { startSilenceCountdown(); return; } // transcription still in flight
        if (rt.generating) return;
        stopInterviewerListener();
        await executeQuery(question, true);
    }

    // --------------------------------------------------- Web Speech (mic) setup
    function transcriptFrom(channel, event) {
        channel.len = event.results.length;
        // Join result segments with a space ourselves: browsers don't always prefix later segments with one.
        const parts = [];
        for (let i = channel.skip; i < event.results.length; i++) parts.push(event.results[i][0].transcript);
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    function handleSpeechError(event, who, stopFn) {
        const code = event.error;
        if (code === 'no-speech' || code === 'aborted') return;
        const messages = {
            'not-allowed': 'Microphone permission was denied. Allow microphone access for this site and try again.',
            'service-not-allowed': 'Speech recognition is blocked for this site in your browser.',
            'audio-capture': 'No microphone was found.',
            'network': "Speech recognition couldn't reach its service. Chrome/Edge need an internet connection for it.",
        };
        toast(`${who}: ${messages[code] || `speech error (${code}).`}`, 'error', 6000);
        stopFn();
    }

    function initSpeech() {
        if (!SpeechRecognitionCtor) return;

        const make = () => {
            const rec = new SpeechRecognitionCtor();
            rec.continuous = true;
            rec.interimResults = true;
            rec.lang = CONFIG.speechLang;
            return rec;
        };

        // Interviewer questions
        const iv = speech.interviewer;
        iv.rec = make();
        iv.rec.onresult = (event) => {
            const text = transcriptFrom(iv, event);
            if (!text) return;
            $('question-input').value = joinText(iv.base, text);
            startSilenceCountdown();
        };
        iv.rec.onerror = (e) => handleSpeechError(e, 'Interviewer stream', stopInterviewerListener);
        iv.rec.onend = () => {
            // Chrome ends sessions on its own; transparently start a new one.
            if (!rt.interviewerListening || rt.tab.active) return;
            iv.base = $('question-input').value.trim();
            iv.skip = 0; iv.len = 0;
            setTimeout(() => {
                if (rt.interviewerListening && !rt.tab.active) { try { iv.rec.start(); } catch { /* already started */ } }
            }, 200);
        };

        // Candidate's own answer
        const cd = speech.candidate;
        cd.rec = make();
        cd.rec.onresult = (event) => {
            const text = transcriptFrom(cd, event);
            if (text) $('candidate-speech-input').value = joinText(cd.base, text);
        };
        cd.rec.onerror = (e) => handleSpeechError(e, 'Candidate mic', stopCandidateMic);
        cd.rec.onend = () => {
            if (!rt.candidateRecording) return;
            cd.base = $('candidate-speech-input').value.trim();
            cd.skip = 0; cd.len = 0;
            setTimeout(() => {
                if (rt.candidateRecording) { try { cd.rec.start(); } catch { /* already started */ } }
            }, 200);
        };
    }

    // ---------------------------------------------------- interviewer listener
    function toggleInterviewerListener() {
        if (rt.interviewerListening) return stopInterviewerListener();
        if (!rt.tab.active && !speech.interviewer.rec) {
            toast('Speech recognition is not supported in this browser. Use Chrome or Edge, or capture tab audio instead.', 'error', 6000);
            return;
        }
        startInterviewerListener();
    }

    function startInterviewerListener() {
        if (rt.candidateRecording) stopCandidateMic(); // mutually exclusive
        const iv = speech.interviewer;

        if (rt.tab.active) {
            rt.tab.seg = freshSegment();
        } else {
            try {
                iv.base = ''; iv.skip = 0; iv.len = 0;
                iv.rec.start();
            } catch (e) {
                if (!(e && e.name === 'InvalidStateError')) {
                    console.error(e);
                    toast('Could not start speech recognition.', 'error');
                    return;
                }
            }
        }
        $('question-input').value = '';
        rt.interviewerListening = true;
        setInterviewerUI(true);
        updateVADUI();
    }

    function stopInterviewerListener() {
        rt.interviewerListening = false;
        clearSilenceTimers();
        if (speech.interviewer.rec) { try { speech.interviewer.rec.stop(); } catch { /* not running */ } }
        rt.tab.seg = freshSegment();
        setInterviewerUI(false);
        updateVADUI();
    }

    function setInterviewerUI(on) {
        const btn = $('btn-toggle-interviewer');
        btn.textContent = on ? 'Stop' : 'Listen';
        btn.classList.toggle('bg-red-600', on);
        btn.classList.toggle('hover:bg-red-500', on);
        btn.classList.toggle('pulse-listening', on);
        btn.classList.toggle('bg-blue-600', !on);
        btn.classList.toggle('hover:bg-blue-500', !on);

        $('dot-sys-audio').className = on ? 'w-2 h-2 rounded-full bg-blue-500 animate-ping' : 'w-2 h-2 rounded-full bg-slate-600';
        $('badge-sys-audio').classList.toggle('border-blue-500/40', on);
        $('badge-sys-audio').classList.toggle('text-blue-400', on);
    }

    // ------------------------------------------------------- candidate mic log
    function toggleCandidateMic() {
        if (rt.candidateRecording) return stopCandidateMic();
        if (!speech.candidate.rec) {
            toast('Speech recognition is not supported in this browser. Use Chrome or Edge.', 'error', 6000);
            return;
        }
        startCandidateMic();
    }

    function startCandidateMic() {
        if (rt.interviewerListening) stopInterviewerListener(); // mutually exclusive
        const cd = speech.candidate;
        try {
            cd.base = $('candidate-speech-input').value.trim();
            cd.skip = 0; cd.len = 0;
            cd.rec.start();
        } catch (e) {
            if (!(e && e.name === 'InvalidStateError')) {
                console.error(e);
                toast('Could not start the microphone.', 'error');
                return;
            }
        }
        rt.candidateRecording = true;
        setCandidateUI(true);
    }

    function stopCandidateMic() {
        rt.candidateRecording = false;
        if (speech.candidate.rec) { try { speech.candidate.rec.stop(); } catch { /* not running */ } }
        setCandidateUI(false);
    }

    function setCandidateUI(on) {
        const btn = $('btn-toggle-candidate');
        btn.textContent = on ? 'Recording Mic...' : 'Record Mic';
        btn.classList.toggle('bg-emerald-600', on);
        btn.classList.toggle('hover:bg-emerald-500', on);
        btn.classList.toggle('pulse-recording', on);
        btn.classList.toggle('bg-slate-800', !on);
        btn.classList.toggle('hover:bg-slate-700', !on);

        $('dot-mic-audio').className = on ? 'w-2 h-2 rounded-full bg-emerald-500 animate-ping' : 'w-2 h-2 rounded-full bg-slate-600';
        $('badge-mic-audio').classList.toggle('border-emerald-500/40', on);
        $('badge-mic-audio').classList.toggle('text-emerald-400', on);
    }

    // ------------------------------------------ tab / meeting audio (real path)
    async function requestSystemAudioCapture() {
        if (rt.tab.active) { releaseTabCapture(); return; } // button doubles as "stop"

        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            toast('Tab audio capture is not supported in this browser. Use Chrome or Edge on desktop.', 'error', 6000);
            return;
        }
        if (!(window.AudioContext || window.webkitAudioContext) || !window.AudioWorkletNode) {
            toast('This browser lacks the audio features needed for tab capture.', 'error', 6000);
            return;
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } catch (e) {
            console.warn('System audio capture canceled or unsupported:', e);
            return; // user cancelled the picker
        }

        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
            stream.getTracks().forEach((t) => t.stop());
            toast("No audio was shared. Pick a Chrome tab (or Entire Screen on Windows) and tick 'Share audio'.", 'error', 7000);
            return;
        }

        try {
            await setupTabPipeline(stream, audioTracks);
        } catch (e) {
            console.error(e);
            stream.getTracks().forEach((t) => t.stop());
            toast(`Could not start tab audio processing: ${e.message || e}`, 'error', 6000);
            return;
        }

        stream.getTracks().forEach((t) => t.addEventListener('ended', () => {
            if (rt.tab.active) { releaseTabCapture(); toast('Tab audio sharing ended.', 'info'); }
        }));

        toast('Tab audio captured. Listening to the interviewer.', 'success');
        startInterviewerListener();
    }

    async function setupTabPipeline(stream, audioTracks) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        if (ctx.state === 'suspended') await ctx.resume();
        await ctx.audioWorklet.addModule('/assets/pcm-worklet.js');

        const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
        const node = new AudioWorkletNode(ctx, 'pcm-capture');
        const mute = ctx.createGain();
        mute.gain.value = 0; // keeps the graph alive without playing the audio a second time
        source.connect(node);
        node.connect(mute);
        mute.connect(ctx.destination);
        node.port.onmessage = (e) => onPcmChunk(e.data);

        Object.assign(rt.tab, { active: true, stream, ctx, node, mute, source, seg: freshSegment() });
        updateTabUI();
    }

    function releaseTabCapture() {
        const t = rt.tab;
        const wasListening = rt.interviewerListening;
        if (wasListening) stopInterviewerListener();
        try { t.node && (t.node.port.onmessage = null); } catch { /* ignore */ }
        try { t.source && t.source.disconnect(); } catch { /* ignore */ }
        try { t.node && t.node.disconnect(); } catch { /* ignore */ }
        try { t.mute && t.mute.disconnect(); } catch { /* ignore */ }
        try { t.stream && t.stream.getTracks().forEach((tr) => tr.stop()); } catch { /* ignore */ }
        try { t.ctx && t.ctx.close(); } catch { /* ignore */ }
        Object.assign(t, { active: false, stream: null, ctx: null, node: null, mute: null, source: null, seg: freshSegment() });
        updateTabUI();
    }

    function updateTabUI() {
        const on = rt.tab.active;
        $('capture-tab-label').textContent = on ? 'Stop Tab / Meeting Audio' : 'Capture Tab / Meeting Audio';
        $('source-hint').textContent = on
            ? 'Source: captured tab/meeting audio (transcribed by Gemini).'
            : 'Source: microphone (speech recognition).';
    }

    function onPcmChunk(chunk) {
        const t = rt.tab;
        if (!rt.interviewerListening || !t.active) return;

        const ms = (chunk.length / t.ctx.sampleRate) * 1000;
        let sum = 0;
        for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
        const loud = Math.sqrt(sum / chunk.length) > CONFIG.vadRmsThreshold;
        const seg = t.seg;

        if (loud) {
            if (!seg.inSpeech) {
                seg.inSpeech = true;
                seg.chunks = seg.preRoll.slice();
                seg.durationMs = seg.preRoll.reduce((n, c) => n + (c.length / t.ctx.sampleRate) * 1000, 0);
                seg.speechMs = 0;
            }
            seg.silentMs = 0;
            seg.speechMs += ms;
            seg.durationMs += ms;
            seg.lastVoiceTs = Date.now();
            seg.chunks.push(chunk);
            if (rt.silence.active) clearSilenceTimers(); // hold the countdown while someone is talking
        } else if (seg.inSpeech) {
            seg.chunks.push(chunk);
            seg.durationMs += ms;
            seg.silentMs += ms;
            if (seg.silentMs >= CONFIG.segmentEndSilenceMs) finalizeSegment();
        } else {
            seg.preRoll.push(chunk);
            if (seg.preRoll.length > 4) seg.preRoll.shift();
        }

        if (seg.inSpeech && seg.durationMs >= CONFIG.maxSegmentMs) finalizeSegment();
    }

    function finalizeSegment() {
        const t = rt.tab;
        const seg = t.seg;
        const { chunks, speechMs, lastVoiceTs } = seg;
        const rate = t.ctx.sampleRate;
        t.seg = freshSegment();

        if (speechMs < CONFIG.minSpeechMs) { resumeCountdownAfterTab(lastVoiceTs); return; }

        const wav = encodeWav(chunks, rate, CONFIG.targetSampleRate);
        t.pending++;
        t.queue = t.queue
            .then(() => transcribeAndAppend(wav, lastVoiceTs))
            .catch(() => { /* handled inside */ })
            .finally(() => {
                t.pending--;
                resumeCountdownAfterTab(lastVoiceTs);
            });
    }

    function resumeCountdownAfterTab(fromTs) {
        const t = rt.tab;
        if (!rt.interviewerListening || !t.active) return;
        if (t.pending > 0 || t.seg.inSpeech) return;
        if (!$('question-input').value.trim()) return;
        startSilenceCountdown(fromTs);
    }

    async function transcribeAndAppend(wavBlob, lastVoiceTs) {
        try {
            const data = await blobToBase64(wavBlob);
            const response = await callGemini({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: 'Transcribe this audio verbatim. Output ONLY the spoken words as plain text, with normal punctuation. If there is no intelligible speech, output nothing.' },
                        { inlineData: { mimeType: 'audio/wav', data } },
                    ],
                }],
                generationConfig: { temperature: 0 },
            });
            const text = extractText(response).replace(/^["“]|["”]$/g, '').trim();
            if (text && rt.interviewerListening && rt.tab.active) {
                $('question-input').value = joinText($('question-input').value, text);
            }
        } catch (err) {
            if (Date.now() - rt.tab.lastErrorToast > 8000) {
                rt.tab.lastErrorToast = Date.now();
                toast(`Transcription failed: ${err.message || err}`, 'error', 6000);
            }
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(reader.error || new Error('Could not read audio'));
            reader.readAsDataURL(blob);
        });
    }

    // Float32 chunks @ srcRate -> 16-bit mono WAV @ dstRate (box-filter downsample).
    function encodeWav(chunks, srcRate, dstRate) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Float32Array(total);
        let offset = 0;
        for (const c of chunks) { merged.set(c, offset); offset += c.length; }

        const ratio = srcRate / dstRate;
        const outLen = Math.max(1, Math.floor(total / ratio));
        const pcm = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const start = Math.floor(i * ratio);
            const end = Math.min(total, Math.floor((i + 1) * ratio));
            let acc = 0, n = 0;
            for (let j = start; j < end; j++) { acc += merged[j]; n++; }
            const v = clamp(n ? acc / n : (merged[start] || 0), -1, 1);
            pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }

        const header = new ArrayBuffer(44);
        const dv = new DataView(header);
        const writeStr = (pos, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(pos + i, str.charCodeAt(i)); };
        writeStr(0, 'RIFF');
        dv.setUint32(4, 36 + pcm.byteLength, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true);            // PCM
        dv.setUint16(22, 1, true);            // mono
        dv.setUint32(24, dstRate, true);
        dv.setUint32(28, dstRate * 2, true);  // byte rate
        dv.setUint16(32, 2, true);            // block align
        dv.setUint16(34, 16, true);           // bits per sample
        writeStr(36, 'data');
        dv.setUint32(40, pcm.byteLength, true);
        return new Blob([header, pcm.buffer], { type: 'audio/wav' });
    }

    // ------------------------------------------------------------- Gemini calls
    function parseApiError(status, bodyText) {
        let message = '';
        try {
            const j = JSON.parse(bodyText);
            message = typeof j.error === 'string' ? j.error : (j.error && j.error.message) || '';
        } catch { /* not JSON */ }
        message = (message || '').slice(0, 300);
        if (status === 401) return message || 'Invalid or missing access code.';
        if (status === 429) return 'Gemini rate limit or quota reached. Wait a moment and try again.';
        if (status === 404 && !message) return 'API endpoint not found. Is the Netlify function deployed?';
        if (status >= 500) return message || `Gemini/server error (${status}).`;
        return message ? `${message} (${status})` : `Request failed (${status}).`;
    }

    async function callGemini(body) {
        const direct = state.customApiKey.trim();
        let url;
        const headers = { 'Content-Type': 'application/json' };
        if (direct) {
            url = `${CONFIG.directEndpoint}/${CONFIG.model}:generateContent?key=${encodeURIComponent(direct)}`;
        } else {
            if (rt.server.checked && !rt.server.reachable) {
                throw new Error('The server proxy is unreachable. Deploy on Netlify (or run `netlify dev`), or paste your own Gemini API key in the sidebar.');
            }
            if (rt.server.checked && rt.server.reachable && !rt.server.configured) {
                throw new Error('No GEMINI_API_KEY is set on the server. Add it in Netlify, or paste your own key in the sidebar.');
            }
            url = CONFIG.proxyEndpoint;
            if (state.accessCode) headers['x-access-code'] = state.accessCode;
        }

        let lastError = new Error('Request failed.');
        let delay = 800;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
                if (res.ok) return await res.json();
                const bodyText = await res.text();
                lastError = new Error(parseApiError(res.status, bodyText));
                lastError.status = res.status;
                // Client errors (bad key, bad request, bad access code) will not fix themselves.
                if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
            } catch (e) {
                lastError = new Error(`Network error: ${e.message || e}`);
            }
            if (attempt < 2) { await sleep(delay); delay *= 2; }
        }
        if (lastError.status === 401 && !direct) {
            $('access-code-wrap').classList.remove('hidden');
        }
        throw lastError;
    }

    function extractText(response) {
        const parts = response?.candidates?.[0]?.content?.parts || [];
        return parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
    }

    function parseJsonLoose(text) {
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        try { return JSON.parse(cleaned); } catch { /* fall through */ }
        const first = cleaned.indexOf('{');
        const last = cleaned.lastIndexOf('}');
        if (first !== -1 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
        throw new Error('The model did not return valid JSON.');
    }

    const asStringList = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map((x) => String(x)).filter(Boolean);
    const asText = (v) => (Array.isArray(v) ? v.join('\n') : String(v ?? ''));

    function normalizeAnswer(raw) {
        const answer = {
            talkingPoints: asStringList(raw.talkingPoints),
            structuredAnswer: asText(raw.structuredAnswer),
            keywords: asStringList(raw.keywords),
            edgeCases: asText(raw.edgeCases),
        };
        if (!answer.talkingPoints.length && !answer.structuredAnswer) {
            throw new Error('The model returned an empty answer.');
        }
        return answer;
    }

    async function executeQuery(question, isAutoTriggered = false) {
        if (rt.generating) { toast('Still generating the previous answer…', 'info'); return; }
        setGenerating(true);

        const history = rt.memory.map((m) => `[${m.type.toUpperCase()}]: ${m.text}`).join('\n');
        const systemPrompt = `You are a real-time AI Interview Teleprompter Copilot for a candidate.
Target Role: ${state.role}. Candidate Background: ${state.context}.
Interview Track: ${state.track.toUpperCase()}.

CONVERSATION HISTORY (Previous turns & candidate actual answers):
${history || 'No previous turns yet.'}

Your job is to provide direct, crisp, high-impact answers optimized for a candidate reading a teleprompter live.

Return ONLY a valid JSON object matching this schema:
{
  "talkingPoints": ["Point 1 (ultra-concise max 12 words)", "Point 2", "Point 3"],
  "structuredAnswer": "Full detailed answer strategy (STAR format for behavioral, step-by-step for technical/system design).",
  "keywords": ["key_term1", "tech2", "metric3"],
  "edgeCases": "Brief note on follow-up questions or edge cases to expect."
}`;

        try {
            const response = await callGemini({
                contents: [{ role: 'user', parts: [{ text: `Current Interviewer Question: "${question}"` }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { responseMimeType: 'application/json' },
            });

            const text = extractText(response);
            if (!text) {
                const reason = response?.promptFeedback?.blockReason || response?.candidates?.[0]?.finishReason;
                throw new Error(reason ? `Gemini returned no answer (${reason}).` : 'Gemini returned an empty response.');
            }
            const parsed = normalizeAnswer(parseJsonLoose(text));

            const timestamp = nowLabel();
            rt.currentAnswer = {
                id: Date.now(),
                question,
                track: state.track,
                isAuto: isAutoTriggered,
                silenceSecs: state.silenceMs / 1000,
                timestamp,
                ...parsed,
            };

            rt.memory.push({ type: 'interviewer_question', text: question, timestamp });
            rt.memory.push({ type: 'ai_suggested_answer', text: parsed.talkingPoints.join(' | ') || parsed.structuredAnswer.slice(0, 300), timestamp });

            renderActiveAnswer();
            renderTranscriptFeed();
            $('candidate-recorder-box').classList.remove('hidden');
        } catch (err) {
            console.error(err);
            toast(`Gemini error: ${err.message || err}`, 'error', 7000);
        } finally {
            setGenerating(false);
        }
    }

    function setGenerating(on) {
        rt.generating = on;
        const btn = $('generate-btn');
        btn.disabled = on;
        btn.innerHTML = on
            ? '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Generating...'
            : '<i data-lucide="sparkles" class="w-4 h-4"></i> Generate Answer Now';
        refreshIcons();
    }

    async function handleManualSubmit(e) {
        e.preventDefault();
        const q = $('question-input').value.trim();
        if (!q) { toast('Type or capture a question first.', 'info'); return; }
        clearSilenceTimers();
        await executeQuery(q, false);
    }

    // ---------------------------------------------------------------- rendering
    function renderActiveAnswer() {
        const a = rt.currentAnswer;
        if (!a) return;

        $('welcome-placeholder').classList.add('hidden');
        $('active-answer-wrapper').classList.remove('hidden');

        $('current-track-tag').textContent = a.track;
        $('current-timestamp').textContent = a.timestamp;
        const badge = $('auto-triggered-badge');
        badge.textContent = `Auto ${a.silenceSecs}s Triggered`;
        badge.style.display = a.isAuto ? 'inline-block' : 'none';
        $('display-question').textContent = `"${a.question}"`;

        $('display-bullets').innerHTML = a.talkingPoints
            .map((pt) => `<li class="flex items-start gap-2 bg-blue-900/20 p-2 rounded-lg border border-blue-500/20"><span class="text-blue-400 font-bold">•</span> <span>${escapeHtml(pt)}</span></li>`)
            .join('');

        $('display-detailed').textContent = a.structuredAnswer;

        $('display-keywords').innerHTML = a.keywords
            .map((kw) => `<span class="px-2 py-1 bg-amber-500/10 text-amber-300 border border-amber-500/20 rounded-md text-[11px] font-mono">${escapeHtml(kw)}</span>`)
            .join('');

        $('display-edgecases').textContent = a.edgeCases || 'None.';
        $('output-scroll-container').scrollTop = 0;
    }

    function renderTranscriptFeed() {
        const container = $('transcript-feed');
        $('transcript-count').textContent = rt.memory.length;

        if (!rt.memory.length) {
            container.innerHTML = '<p class="text-xs text-slate-600 italic">No turns logged yet.</p>';
            return;
        }

        container.innerHTML = rt.memory.map((item) => {
            let badgeClass = 'bg-blue-500/10 text-blue-400 border-blue-500/20';
            let label = 'Interviewer Question';
            let icon = 'volume-2';
            if (item.type === 'ai_suggested_answer') {
                badgeClass = 'bg-purple-500/10 text-purple-400 border-purple-500/20';
                label = 'AI Teleprompter Suggestion';
                icon = 'sparkles';
            } else if (item.type === 'candidate_actual_answer') {
                badgeClass = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
                label = 'Candidate Spoken Answer';
                icon = 'mic';
            }
            return `
                <div class="p-3 bg-slate-900 border border-slate-800 rounded-lg space-y-1">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] px-2 py-0.5 border ${badgeClass} rounded font-mono flex items-center gap-1">
                            <i data-lucide="${icon}" class="w-3 h-3"></i> ${label}
                        </span>
                        <span class="text-[10px] text-slate-500">${escapeHtml(item.timestamp)}</span>
                    </div>
                    <p class="text-xs text-slate-200">${escapeHtml(item.text)}</p>
                </div>`;
        }).join('');
        refreshIcons();
    }

    // ------------------------------------------------------- settings & actions
    function setTrack(track) {
        state.track = track;
        document.querySelectorAll('.track-btn').forEach((btn) => {
            const active = btn.dataset.track === track;
            btn.classList.toggle('border-blue-500/50', active);
            btn.classList.toggle('bg-blue-500/10', active);
            btn.classList.toggle('text-blue-400', active);
            btn.classList.toggle('border-slate-800', !active);
            btn.classList.toggle('bg-slate-900', !active);
            btn.classList.toggle('text-slate-400', !active);
        });
        saveSettings();
    }

    function switchView(mode) {
        state.view = mode;
        const stealth = mode === 'stealth';
        $('sidebar').classList.toggle('hidden', stealth);
        $('main-header').classList.toggle('bg-slate-950/40', stealth);
        $('main-header').classList.toggle('border-slate-800/40', stealth);
        document.body.classList.toggle('stealth-active', stealth);

        const dash = $('tab-dashboard-btn');
        const st = $('tab-stealth-btn');
        dash.classList.toggle('bg-blue-600', !stealth);
        dash.classList.toggle('text-white', !stealth);
        dash.classList.toggle('text-slate-400', stealth);
        st.classList.toggle('bg-blue-600', stealth);
        st.classList.toggle('text-white', stealth);
        st.classList.toggle('text-slate-400', !stealth);
    }

    function adjustOpacity(value) {
        state.opacity = clamp(Number(value) || 100, 30, 100);
        $('app-container').style.opacity = state.opacity / 100;
        saveSettings();
    }

    function clearInput() {
        $('question-input').value = '';
        clearSilenceTimers();
        // Ignore everything the recognizer has already heard in this session.
        speech.interviewer.base = '';
        speech.interviewer.skip = speech.interviewer.len;
    }

    function clearAllLogs() {
        if (!confirm('Clear session transcript feed and memory?')) return;
        rt.memory = [];
        renderTranscriptFeed();
    }

    function exportTranscriptLog() {
        if (!rt.memory.length) { toast('Transcript log is empty.', 'info'); return; }
        const blob = new Blob([JSON.stringify(rt.memory, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `interview-transcript-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function copyAnswerToClipboard() {
        const a = rt.currentAnswer;
        if (!a) return;
        const text = `Question: ${a.question}\n\nTalking Points:\n${a.talkingPoints.map((p) => `- ${p}`).join('\n')}\n\nFull Strategy:\n${a.structuredAnswer}`;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        toast('Copied complete answer to clipboard!', 'success');
    }

    function saveCandidateResponse() {
        const input = $('candidate-speech-input');
        const text = input.value.trim();
        if (!text) return;

        rt.memory.push({ type: 'candidate_actual_answer', text, timestamp: nowLabel() });
        input.value = '';
        speech.candidate.base = '';
        speech.candidate.skip = speech.candidate.len; // don't re-add what was just saved
        $('candidate-recorder-box').classList.add('hidden');
        renderTranscriptFeed();
        toast('Candidate actual response saved to context memory!', 'success');
    }

    function openModal(id) {
        $(id).classList.remove('hidden');
    }

    function closeModal(id) {
        $(id).classList.add('hidden');
    }

    function openContextModal() {
        $('input-role').value = state.role;
        $('input-exp').value = state.experience;
        $('input-summary').value = state.context;
        openModal('context-modal');
    }

    function saveContext() {
        state.role = $('input-role').value.trim() || DEFAULTS.role;
        state.experience = $('input-exp').value.trim();
        state.context = $('input-summary').value.trim();
        renderProfile();
        saveSettings();
        closeModal('context-modal');
    }

    function renderProfile() {
        $('profile-role-display').textContent = state.role;
        $('profile-summary-display').textContent = state.context;
        const exp = $('profile-exp-display');
        exp.textContent = state.experience;
        exp.classList.toggle('hidden', !state.experience);
    }

    // ----------------------------------------------------- server health/status
    async function checkServer() {
        try {
            const res = await fetch(CONFIG.proxyEndpoint, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok || typeof data.configured !== 'boolean') throw new Error('unexpected response');
            Object.assign(rt.server, { checked: true, reachable: true, ...data });
        } catch {
            Object.assign(rt.server, { checked: true, reachable: false, configured: false, accessCodeRequired: false });
        }
        renderStatus();
    }

    function renderStatus() {
        const dot = $('status-dot');
        const text = $('status-text');
        const set = (color, msg) => {
            dot.className = `w-2 h-2 rounded-full shrink-0 ${color}`;
            text.textContent = msg;
        };
        const usingOwnKey = Boolean(state.customApiKey.trim());

        if (usingOwnKey) set('bg-emerald-500', `Gemini ready · your API key`);
        else if (!rt.server.checked) set('bg-slate-600', 'Checking Gemini…');
        else if (!rt.server.reachable) set('bg-red-500', 'Proxy unreachable — add an API key');
        else if (!rt.server.configured) set('bg-amber-500', 'Server key missing — add one');
        else set('bg-emerald-500', `Gemini connected · ${rt.server.model}`);

        const needsCode = rt.server.accessCodeRequired && !usingOwnKey;
        $('access-code-wrap').classList.toggle('hidden', !needsCode);
        $('custom-api-key').placeholder = rt.server.configured ? 'Using server key...' : 'Paste your Gemini API key...';
    }

    // --------------------------------------------------------------------- init
    function bind() {
        $('btn-toggle-interviewer').addEventListener('click', toggleInterviewerListener);
        $('btn-capture-tab').addEventListener('click', requestSystemAudioCapture);
        $('btn-toggle-candidate').addEventListener('click', toggleCandidateMic);

        $('auto-trigger-toggle').addEventListener('change', (e) => {
            state.autoVAD = e.target.checked;
            if (!state.autoVAD) clearSilenceTimers();
            updateVADUI();
            saveSettings();
        });
        $('silence-slider').addEventListener('input', (e) => {
            state.silenceMs = clamp(parseInt(e.target.value, 10) || 3, 1, 7) * 1000;
            clearSilenceTimers();
            applySilenceDelayUI();
            saveSettings();
        });
        $('opacity-slider').addEventListener('input', (e) => adjustOpacity(e.target.value));

        document.querySelectorAll('.track-btn').forEach((btn) => {
            btn.addEventListener('click', () => setTrack(btn.dataset.track));
        });

        $('custom-api-key').addEventListener('input', (e) => {
            state.customApiKey = e.target.value.trim();
            saveSettings();
            renderStatus();
        });
        $('access-code').addEventListener('input', (e) => {
            state.accessCode = e.target.value;
            saveSettings();
        });

        $('btn-edit-context').addEventListener('click', openContextModal);
        $('btn-save-context').addEventListener('click', saveContext);
        $('btn-privacy').addEventListener('click', () => openModal('privacy-modal'));
        document.querySelectorAll('[data-close]').forEach((el) => {
            el.addEventListener('click', () => closeModal(el.dataset.close));
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeModal('privacy-modal'); closeModal('context-modal'); }
        });

        $('tab-dashboard-btn').addEventListener('click', () => switchView('dashboard'));
        $('tab-stealth-btn').addEventListener('click', () => switchView('stealth'));

        $('question-form').addEventListener('submit', handleManualSubmit);
        $('btn-clear-input').addEventListener('click', clearInput);
        $('btn-copy').addEventListener('click', copyAnswerToClipboard);
        $('btn-save-candidate').addEventListener('click', saveCandidateResponse);
        $('btn-export').addEventListener('click', exportTranscriptLog);
        $('btn-clear-logs').addEventListener('click', clearAllLogs);
    }

    function init() {
        initSpeech();
        bind();

        $('auto-trigger-toggle').checked = state.autoVAD;
        $('silence-slider').value = String(state.silenceMs / 1000);
        $('opacity-slider').value = String(state.opacity);
        $('custom-api-key').value = state.customApiKey;
        $('access-code').value = state.accessCode;
        rt.silence.remaining = state.silenceMs / 1000;

        setTrack(state.track);
        renderProfile();
        applySilenceDelayUI();
        adjustOpacity(state.opacity);
        switchView('dashboard');
        renderStatus();
        renderTranscriptFeed();
        refreshIcons();
        checkServer();

        if (!SpeechRecognitionCtor) {
            toast('Live speech recognition needs Chrome or Edge. You can still type questions or capture tab audio.', 'info', 7000);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Test hook (harmless in production): exposes internals for the automated checks.
    window.__copilot = { state, rt, CONFIG, encodeWav, parseJsonLoose, normalizeAnswer, escapeHtml };
})();

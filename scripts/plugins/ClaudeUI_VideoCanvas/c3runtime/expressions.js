
const C3 = globalThis.C3;

C3.Plugins.ClaudeUI_VideoCanvas.Exps =
{
	Duration() { return this.duration; },
	PlaybackTime() { return this.playbackTime; },
	VideoWidth() { return this.videoWidth; },
	VideoHeight() { return this.videoHeight; },
	Source() { return this.source; },
	ErrorMessage() { return this.errorMessage; }
};

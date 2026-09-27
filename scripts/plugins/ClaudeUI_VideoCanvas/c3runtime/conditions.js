
const C3 = globalThis.C3;

C3.Plugins.ClaudeUI_VideoCanvas.Cnds =
{
	OnReady()
	{
		return true;
	},

	OnEnded()
	{
		return true;
	},

	OnError()
	{
		return true;
	},

	IsPlaying()
	{
		return this.isPlaying;
	}
};

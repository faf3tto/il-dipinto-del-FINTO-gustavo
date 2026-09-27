
const C3 = globalThis.C3;

C3.Plugins.ClaudeUI_VideoCanvas.Acts =
{
	SetSource(src)
	{
		this.setSource(src);
	},

	Play()
	{
		this.play();
	},

	Pause()
	{
		this.pause();
	},

	Stop()
	{
		this.stop();
	},

	SetTime(t)
	{
		this.setTime(t);
	},

	SetVolume(v)
	{
		this.setVolume(v);
	},

	SetMuted(m)
	{
		this.setMuted(m);
	},

	SetLooping(l)
	{
		this.setLooping(l);
	},

	SetPlaybackRate(r)
	{
		this.setPlaybackRate(r);
	}
};

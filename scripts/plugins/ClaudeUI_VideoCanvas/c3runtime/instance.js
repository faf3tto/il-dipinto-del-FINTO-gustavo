
const C3 = globalThis.C3;

// Must match the ID in domSide.js
const DOM_COMPONENT_ID = "claudeui-videocanvas";

C3.Plugins.ClaudeUI_VideoCanvas.Instance = class VideoCanvasInstance extends globalThis.ISDKWorldInstanceBase
{
	constructor()
	{
		super({ domComponentId: DOM_COMPONENT_ID });

		// Properties
		this._source = "";
		this._autoplay = false;
		this._loop = false;
		this._muted = false;
		this._volume = 100;
		this._rate = 1;

		const properties = this._getInitProperties();
		if (properties)
		{
			this._source = properties[0] || "";
			this._autoplay = !!properties[1];
			this._loop = !!properties[2];
			this._muted = !!properties[3];
			this._volume = (typeof properties[4] === "number") ? properties[4] : 100;
		}

		// Playback state mirrored from the DOM side
		this._duration = 0;
		this._time = 0;
		this._isPlaying = false;
		this._videoW = 0;
		this._videoH = 0;
		this._lastError = "";

		// Rendering
		this._texture = null;
		this._texW = 0;
		this._texH = 0;
		this._pendingFrame = null;
		this._pollInFlight = false;
		this._warnedNoDynTex = false;

		try
		{
			this._postToDOM("video-create", { "id": this.uid, "state": this._stateForDom() });
		}
		catch (e)
		{
			console.warn("[VideoCanvas] DOM messaging unavailable:", e);
		}

		if (this._source)
			this._applySource();

		this._setTicking(true);
	}

	_release()
	{
		try { this._postToDOM("video-destroy", { "id": this.uid }); }
		catch (e) {}

		if (this._pendingFrame)
		{
			try { this._pendingFrame.close(); } catch (e) {}
			this._pendingFrame = null;
		}

		if (this._texture)
		{
			try
			{
				const r = this.runtime ? this.runtime.renderer : null;
				if (r && typeof r.deleteTexture === "function")
					r.deleteTexture(this._texture);
			}
			catch (e) {}
			this._texture = null;
		}

		super._release();
	}

	_stateForDom()
	{
		return {
			"muted": this._muted,
			"loop": this._loop,
			"volume": Math.max(0, Math.min(1, this._volume / 100)),
			"rate": this._rate
		};
	}

	_pushState()
	{
		try { this._postToDOM("video-cmd", { "id": this.uid, "cmd": "state", "value": this._stateForDom() }); }
		catch (e) {}
	}

	_cmd(cmd, value)
	{
		try { this._postToDOM("video-cmd", { "id": this.uid, "cmd": cmd, "value": value }); }
		catch (e) {}
	}

	async _applySource()
	{
		let url = this._source;
		if (!url)
			return;

		// Anything that's not an absolute/blob/data URL is treated as a
		// project file name (add the video to the project's Files folder)
		if (!/^(https?:|blob:|data:)/i.test(url))
		{
			try
			{
				url = await this.runtime.assets.getProjectFileUrl(url);
				if (!url)
					throw new Error("not found");
			}
			catch (e)
			{
				this._lastError = "Project file not found: " + this._source;
				console.warn("[VideoCanvas] " + this._lastError);
				this._trigger(C3.Plugins.ClaudeUI_VideoCanvas.Cnds.OnError);
				return;
			}
		}

		try
		{
			this._postToDOM("video-set-source", {
				"id": this.uid,
				"url": url,
				"autoplay": this._autoplay
			});
		}
		catch (e) {}
	}

	_tick()
	{
		if (this._pollInFlight)
			return;

		this._pollInFlight = true;

		let p = null;
		try { p = this._postToDOMAsync("video-poll", { "id": this.uid }); }
		catch (e)
		{
			this._pollInFlight = false;
			return;
		}

		p.then(data =>
		{
			this._pollInFlight = false;
			if (!data)
				return;

			this._time = data["time"] || 0;
			this._duration = data["duration"] || 0;
			this._isPlaying = !!data["playing"];
			this._videoW = data["w"] || 0;
			this._videoH = data["h"] || 0;

			if (data["frame"])
			{
				if (this._pendingFrame)
				{
					try { this._pendingFrame.close(); } catch (e) {}
				}
				this._pendingFrame = data["frame"];

				// Nudge the renderer in case render-skipping is active
				try
				{
					if (this.runtime.sdk && typeof this.runtime.sdk.updateRender === "function")
						this.runtime.sdk.updateRender();
				}
				catch (e) {}
			}

			const evs = data["events"] || [];
			for (const ev of evs)
			{
				if (ev === "ended")
					this._trigger(C3.Plugins.ClaudeUI_VideoCanvas.Cnds.OnEnded);
				else if (ev === "ready")
					this._trigger(C3.Plugins.ClaudeUI_VideoCanvas.Cnds.OnReady);
				else if (ev === "error")
				{
					this._lastError = data["error"] || this._lastError || "video error";
					console.warn("[VideoCanvas] " + this._lastError);
					this._trigger(C3.Plugins.ClaudeUI_VideoCanvas.Cnds.OnError);
				}
			}
		})
		.catch(() => { this._pollInFlight = false; });
	}

	_draw(renderer)
	{
		// Upload the most recent frame to a dynamic texture
		if (this._pendingFrame)
		{
			const fw = this._pendingFrame.width;
			const fh = this._pendingFrame.height;

			try
			{
				if (this._texture && (this._texW !== fw || this._texH !== fh))
				{
					if (typeof renderer.deleteTexture === "function")
						renderer.deleteTexture(this._texture);
					this._texture = null;
				}

				if (!this._texture)
				{
					if (typeof renderer.createDynamicTexture === "function")
					{
						this._texture = renderer.createDynamicTexture(fw, fh, { "mipMap": false });
						this._texW = fw;
						this._texH = fh;
					}
					else if (!this._warnedNoDynTex)
					{
						this._warnedNoDynTex = true;
						console.warn("[VideoCanvas] renderer.createDynamicTexture not available in this Construct version");
					}
				}

				if (this._texture && typeof renderer.updateTexture === "function")
					renderer.updateTexture(this._pendingFrame, this._texture, { "premultiplyAlpha": true });
			}
			catch (e)
			{
				console.warn("[VideoCanvas] texture update failed:", e);
			}

			try { this._pendingFrame.close(); } catch (e) {}
			this._pendingFrame = null;
		}

		if (this._texture)
		{
			renderer.setTexture(this._texture, this.activeSampling);
			renderer.quad3(this.getBoundingQuad(), new C3.Rect(0, 0, 1, 1));
		}
		else
		{
			// Nothing decoded yet: draw a black placeholder
			try
			{
				renderer.setColorFillMode();
				renderer.setColorRgba(0, 0, 0, 1);
				renderer.quad(this.getBoundingQuad());
				renderer.setTextureFillMode();
			}
			catch (e) {}
		}
	}

	// -----------------------------------------------------------
	// API used by ACEs
	// -----------------------------------------------------------
	setSource(src)
	{
		this._source = src || "";
		this._lastError = "";
		this._applySource();
	}

	play() { this._cmd("play"); }
	pause() { this._cmd("pause"); }
	stop() { this._cmd("stop"); }

	setTime(t)
	{
		if (typeof t === "number" && isFinite(t))
			this._cmd("time", Math.max(0, t));
	}

	setVolume(v)
	{
		if (typeof v === "number" && isFinite(v))
		{
			this._volume = Math.max(0, Math.min(100, v));
			this._pushState();
		}
	}

	setMuted(m)
	{
		this._muted = !!m;
		this._pushState();
	}

	setLooping(l)
	{
		this._loop = !!l;
		this._pushState();
	}

	setPlaybackRate(r)
	{
		if (typeof r === "number" && isFinite(r) && r > 0)
		{
			this._rate = r;
			this._pushState();
		}
	}

	get isPlaying() { return this._isPlaying; }
	get duration() { return this._duration; }
	get playbackTime() { return this._time; }
	get videoWidth() { return this._videoW; }
	get videoHeight() { return this._videoH; }
	get source() { return this._source; }
	get errorMessage() { return this._lastError; }

	_saveToJson()
	{
		return {
			"src": this._source,
			"t": this._time,
			"vol": this._volume,
			"mut": this._muted,
			"loop": this._loop,
			"rate": this._rate,
			"play": this._isPlaying
		};
	}

	_loadFromJson(o)
	{
		this._source = o["src"] || "";
		this._volume = (typeof o["vol"] === "number") ? o["vol"] : 100;
		this._muted = !!o["mut"];
		this._loop = !!o["loop"];
		this._rate = (typeof o["rate"] === "number") ? o["rate"] : 1;
		this._pushState();

		if (this._source)
		{
			this._applySource();
			const t = o["t"] || 0;
			if (t > 0)
				this.setTime(t);
			if (o["play"])
				this.play();
		}
	}
};

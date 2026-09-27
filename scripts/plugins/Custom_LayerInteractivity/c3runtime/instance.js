
const C3 = globalThis.C3;

C3.Plugins.Custom_LayerInteractivity.Instance = class LayerInteractivityInstance extends globalThis.ISDKInstanceBase
{
	constructor()
	{
		super();
		// No runtime/instance access here: everything happens inside actions,
		// which run after initialisation. This avoids any black-screen on start.
	}

	// Enumerate all layers of a layout defensively (works whatever the count API is).
	_getAllLayers(layout)
	{
		const out = [];
		if (!layout) return out;
		try
		{
			if (typeof layout.getLayers === "function")
			{
				const arr = layout.getLayers();
				if (arr && arr.length !== undefined) { for (const l of arr) out.push(l); return out; }
			}
		}
		catch (e) { /* fall through */ }
		for (let i = 0; i < 1000; i++)
		{
			let layer = null;
			try { layer = layout.getLayer(i); } catch (e) { break; }
			if (!layer) break;
			out.push(layer);
		}
		return out;
	}

	_getLayer(name)
	{
		try { return this.runtime.layout.getLayer(name); }
		catch (e) { return null; }
	}

	// Make ONLY the named layer interactive; every other layer non-interactive.
	isolateInteractive(name)
	{
		for (const l of this._getAllLayers(this.runtime.layout))
			l.isInteractive = (l.name === name);
	}

	// The reverse: make only the named layer NON-interactive; all others interactive.
	isolateNonInteractive(name)
	{
		for (const l of this._getAllLayers(this.runtime.layout))
			l.isInteractive = (l.name !== name);
	}

	setAllInteractive(v)
	{
		for (const l of this._getAllLayers(this.runtime.layout))
			l.isInteractive = !!v;
	}

	setLayerInteractive(name, v)
	{
		const l = this._getLayer(name);
		if (l) l.isInteractive = !!v;
	}

	isLayerInteractive(name)
	{
		const l = this._getLayer(name);
		return l ? !!l.isInteractive : false;
	}
};

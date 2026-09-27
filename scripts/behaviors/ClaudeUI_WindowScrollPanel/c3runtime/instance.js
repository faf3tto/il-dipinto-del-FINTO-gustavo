
const C3 = globalThis.C3;

const DIR_VERTICAL = 0;
const DIR_HORIZONTAL = 1;
const DIR_BOTH = 2;

const EPS = 0.0001;

function clamp(v, lo, hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

C3.Behaviors.ClaudeUI_WindowScrollPanel.Instance = class WindowScrollPanelInstance extends globalThis.ISDKBehaviorInstanceBase
{
	constructor()
	{
		super();

		// Properties
		this._direction = DIR_VERTICAL;
		this._margin = 0;
		this._wheelEnabled = true;
		this._wheelSpeed = 48;
		this._dragScroll = false;
		this._smoothing = 0;
		this._autoAddChildren = true;
		this._didAutoAdd = false;
		this._clipMode = 0;		// 0 = mesh, 1 = none (layer mask)
		this._clicksInsideOnly = true;

		const properties = this._getInitProperties();
		if (properties)
		{
			this._direction = this._readCombo(properties[0], ["vertical", "horizontal", "both"]);
			this._margin = properties[1] || 0;
			this._wheelEnabled = !!properties[2];
			this._wheelSpeed = (typeof properties[3] === "number") ? properties[3] : 48;
			this._dragScroll = !!properties[4];
			this._smoothing = properties[5] || 0;
			this._autoAddChildren = (properties.length > 6) ? !!properties[6] : true;
			this._clipMode = (properties.length > 7) ? this._readCombo(properties[7], ["mesh", "none"]) : 0;
			this._clicksInsideOnly = (properties.length > 8) ? !!properties[8] : true;
		}

		// Scroll state. _scrollX/Y is the target; _dispX/Y is what is currently applied to content.
		this._scrollX = 0;
		this._scrollY = 0;
		this._dispX = 0;
		this._dispY = 0;

		// Scroll limits (recomputed every tick)
		this._minX = 0; this._maxX = 0;
		this._minY = 0; this._maxY = 0;
		this._contentW = 0;
		this._contentH = 0;

		// Registered content: root instances + per-instance metadata
		this._roots = new Set();
		this._lastPanelX = null;
		this._lastPanelY = null;
		this._meta = new Map();		// inst -> { ox, oy, meshed, hidden, unsupported }
		this._pendingUids = null;	// for savegame restore

		// Optional auto-managed layer mask (for Clipping = None setups)
		this._maskClass = null;
		this._maskInsts = null;
		this._maskGeo = null;		// cached geometry: update strips only on change
		this._maskTopRef = null;	// cached topmost window element for z placement
		this._maskHiddenByVis = false;	// strips hidden because the panel is invisible
		this._diagAccum = 0;
		this._warnedMaskInMesh = false;

		// Input
		this._listenersAdded = false;
		this._lastClientX = 0;
		this._lastClientY = 0;
		this._dragPointerId = null;
		this._dragLastLX = 0;
		this._dragLastLY = 0;

		this._boundWheel = e => this._onWheel(e);
		this._boundPointerDown = e => this._onPointerDown(e);
		this._boundPointerMove = e => this._onPointerMove(e);
		this._boundPointerUp = e => this._onPointerUp(e);
		this._boundInstanceDestroy = e => this._onInstanceDestroy(e);

		const B = C3.Behaviors.ClaudeUI_WindowScrollPanel;
		if (!B._allPanels)
			B._allPanels = new Set();
		B._allPanels.add(this);

		this._setTicking(true);
	}

	_release()
	{
		this._destroyMaskInstances();

		const B = C3.Behaviors.ClaudeUI_WindowScrollPanel;
		if (B._allPanels)
			B._allPanels.delete(this);

		this._removeListeners();

		// Restore content to a clean state
		for (const inst of Array.from(this._meta.keys()))
			this._restoreInstance(inst);

		this._roots.clear();
		this._meta.clear();

		super._release();
	}

	_readCombo(value, items)
	{
		if (typeof value === "number")
			return Math.max(0, Math.min(items.length - 1, Math.floor(value)));
		const idx = items.indexOf(value);
		return idx >= 0 ? idx : 0;
	}

	// ---------------------------------------------------------------
	// Input listeners
	// ---------------------------------------------------------------
	_addListeners()
	{
		if (this._listenersAdded)
			return;

		const rt = this.runtime;
		if (!rt)
			return;

		const tryAdd = (name, fn) => { try { rt.addEventListener(name, fn); } catch (e) {} };

		tryAdd("wheel", this._boundWheel);
		tryAdd("pointerdown", this._boundPointerDown);
		tryAdd("pointermove", this._boundPointerMove);
		tryAdd("pointerup", this._boundPointerUp);
		tryAdd("pointercancel", this._boundPointerUp);
		tryAdd("instancedestroy", this._boundInstanceDestroy);

		this._listenersAdded = true;
	}

	_removeListeners()
	{
		if (!this._listenersAdded)
			return;

		const rt = this.runtime;
		if (rt)
		{
			const tryRemove = (name, fn) => { try { rt.removeEventListener(name, fn); } catch (e) {} };

			tryRemove("wheel", this._boundWheel);
			tryRemove("pointerdown", this._boundPointerDown);
			tryRemove("pointermove", this._boundPointerMove);
			tryRemove("pointerup", this._boundPointerUp);
			tryRemove("pointercancel", this._boundPointerUp);
			tryRemove("instancedestroy", this._boundInstanceDestroy);
		}

		this._listenersAdded = false;
	}

	_isPanelInteractive()
	{
		try
		{
			const layer = this.instance.layer;
			if (!layer)
				return true;
			if (typeof layer.isSelfAndParentsInteractive === "boolean")
				return layer.isSelfAndParentsInteractive;
			if (typeof layer.isInteractive === "boolean")
				return layer.isInteractive;
		}
		catch (e) {}
		return true;
	}

	_isPanelVisible()
	{
		try
		{
			if (!this.instance.isVisible)
				return false;

			const layer = this.instance.layer;
			if (layer)
			{
				if (typeof layer.isSelfAndParentsVisible === "boolean")
					return layer.isSelfAndParentsVisible;
				if (typeof layer.isVisible === "boolean")
					return layer.isVisible;
			}
		}
		catch (e) {}
		return true;
	}

	_renderOrderKey()
	{
		let layerIndex = 0, zIndex = 0;
		try
		{
			const layer = this.instance.layer;
			if (layer && typeof layer.index === "number")
				layerIndex = layer.index;
		}
		catch (e) {}
		try { zIndex = this.instance.zIndex || 0; }
		catch (e) {}
		return [layerIndex, zIndex];
	}

	// True if this panel is the top-most eligible panel under the given client point.
	// Eligible = interactive layer, visible, and containing the point.
	_isTopmostPanelAt(clientX, clientY)
	{
		const B = C3.Behaviors.ClaudeUI_WindowScrollPanel;
		const all = B._allPanels;
		if (!all || all.size <= 1)
			return true;

		let top = null;
		let topKey = null;

		for (const b of all)
		{
			try
			{
				if (!b._isPanelInteractive() || !b._isPanelVisible())
					continue;

				const p = b._clientToLayer(clientX, clientY);
				if (!p || !b._isLayerPointInPanel(p[0], p[1]))
					continue;

				const key = b._renderOrderKey();
				if (top === null ||
					key[0] > topKey[0] ||
					(key[0] === topKey[0] && key[1] >= topKey[1]))
				{
					top = b;
					topKey = key;
				}
			}
			catch (e) {}
		}

		return top === this;
	}

	_clientToLayer(clientX, clientY)
	{
		try
		{
			const layer = this.instance.layer;
			if (layer && typeof layer.cssPxToLayer === "function")
				return layer.cssPxToLayer(clientX, clientY);
		}
		catch (e) {}
		return null;
	}

	_isLayerPointInPanel(lx, ly)
	{
		try
		{
			const bb = this.instance.getBoundingBox();
			return lx >= bb.left && lx <= bb.right && ly >= bb.top && ly <= bb.bottom;
		}
		catch (e)
		{
			return false;
		}
	}

	_onWheel(e)
	{
		if (!this._wheelEnabled || !this._isPanelInteractive())
			return;

		const cx = (e && typeof e.clientX === "number") ? e.clientX : this._lastClientX;
		const cy = (e && typeof e.clientY === "number") ? e.clientY : this._lastClientY;

		const p = this._clientToLayer(cx, cy);
		if (!p || !this._isLayerPointInPanel(p[0], p[1]))
			return;

		if (!this._isTopmostPanelAt(cx, cy))
			return;

		const deltaY = (e && typeof e.deltaY === "number") ? e.deltaY : 0;
		if (deltaY === 0)
			return;

		const step = Math.sign(deltaY) * this._wheelSpeed;

		if (this._direction === DIR_HORIZONTAL)
			this.scrollX = this._scrollX + step;
		else
			this.scrollY = this._scrollY + step;
	}

	_onPointerDown(e)
	{
		if (!e)
			return;

		if (typeof e.clientX === "number")
		{
			this._lastClientX = e.clientX;
			this._lastClientY = e.clientY;
		}

		if (!this._dragScroll || this._dragPointerId !== null || !this._isPanelInteractive())
			return;

		const p = this._clientToLayer(e.clientX, e.clientY);
		if (!p || !this._isLayerPointInPanel(p[0], p[1]))
			return;

		if (!this._isTopmostPanelAt(e.clientX, e.clientY))
			return;

		this._dragPointerId = (typeof e.pointerId !== "undefined") ? e.pointerId : "mouse";
		this._dragLastLX = p[0];
		this._dragLastLY = p[1];
	}

	_onPointerMove(e)
	{
		if (!e)
			return;

		if (typeof e.clientX === "number")
		{
			this._lastClientX = e.clientX;
			this._lastClientY = e.clientY;
		}

		if (this._dragPointerId === null)
			return;

		if (!this._isPanelInteractive())
		{
			this._dragPointerId = null;
			return;
		}

		const pid = (typeof e.pointerId !== "undefined") ? e.pointerId : "mouse";
		if (pid !== this._dragPointerId)
			return;

		const p = this._clientToLayer(e.clientX, e.clientY);
		if (!p)
			return;

		const dx = p[0] - this._dragLastLX;
		const dy = p[1] - this._dragLastLY;
		this._dragLastLX = p[0];
		this._dragLastLY = p[1];

		// Dragging content down means scrolling up (content follows the pointer)
		if (this._direction === DIR_HORIZONTAL || this._direction === DIR_BOTH)
		{
			this._scrollX = clamp(this._scrollX - dx, this._minX, this._maxX);
			this._dispX = this._scrollX;	// instant while dragging (delta applied next tick)
		}
		if (this._direction === DIR_VERTICAL || this._direction === DIR_BOTH)
		{
			this._scrollY = clamp(this._scrollY - dy, this._minY, this._maxY);
		}
	}

	_onPointerUp(e)
	{
		if (this._dragPointerId === null)
			return;

		const pid = (e && typeof e.pointerId !== "undefined") ? e.pointerId : "mouse";
		if (pid === this._dragPointerId)
			this._dragPointerId = null;
	}

	_onInstanceDestroy(e)
	{
		if (!e || !e.instance)
			return;

		const inst = e.instance;
		this._roots.delete(inst);
		this._meta.delete(inst);

		if (this._maskInsts)
		{
			const mi = this._maskInsts.indexOf(inst);
			if (mi >= 0)
				this._maskInsts[mi] = null;
		}

		if (inst === this._maskTopRef)
			this._maskTopRef = null;
	}

	// ---------------------------------------------------------------
	// Content registration
	// ---------------------------------------------------------------
	_registerContent(inst)
	{
		if (!inst || inst === this.instance || this._isMaskInstance(inst))
			return;

		this._maskTopRef = null;	// re-evaluate strip z-order

		try
		{
			if (typeof inst.getParent === "function" && inst.getParent() !== this.instance)
			{
				this.instance.addChild(inst, {
					transformX: true,
					transformY: true,
					destroyWithParent: true
				});
			}
		}
		catch (e) {}

		this._roots.add(inst);
		this._ensureMeta(inst);
	}

	_unregisterContent(inst)
	{
		if (!inst)
			return;

		this._maskTopRef = null;	// re-evaluate strip z-order
		this._roots.delete(inst);
		this._restoreInstance(inst);
		this._meta.delete(inst);

		try
		{
			if (typeof inst.getParent === "function" && inst.getParent() === this.instance)
				this.instance.removeChild(inst);
		}
		catch (e) {}
	}

	_restoreInstance(inst)
	{
		const m = this._meta.get(inst);
		if (!m)
			return;

		try
		{
			if (m.meshed)
				inst.releaseMesh();
		}
		catch (e) {}

		try
		{
			if (m.hidden)
				inst.isVisible = !!m.restoreVis;
		}
		catch (e) {}

		this._restoreCollision(inst, m);

		m.meshed = false;
		m.hidden = false;
	}

	_ensureMeta(inst)
	{
		let m = this._meta.get(inst);
		if (m)
			return m;

		let ox = 0.5, oy = 0.5;
		try
		{
			let ang = 0;
			try { ang = inst.angle || 0; } catch (e) {}

			const wasRotated = Math.abs(ang) > 0.0001;
			if (wasRotated)
				inst.angle = 0;

			const bb = inst.getBoundingBox();
			if (bb.width > 0)
				ox = (inst.x - bb.left) / bb.width;
			if (bb.height > 0)
				oy = (inst.y - bb.top) / bb.height;

			if (wasRotated)
				inst.angle = ang;
		}
		catch (e) {}

		m = { ox: ox, oy: oy, meshed: false, hidden: false, unsupported: false, restoreVis: true, restoreColl: true, collOff: false };
		this._meta.set(inst, m);
		return m;
	}

	// Full (un-clipped) axis-aligned rect of an instance, independent of any mesh we applied
	_fullRect(inst, m)
	{
		const w = Math.abs(inst.width);
		const h = Math.abs(inst.height);
		const l = inst.x - m.ox * w;
		const t = inst.y - m.oy * h;
		return [l, t, l + w, t + h];
	}

	// Axis-aligned bounds of an instance, accounting for its rotation
	_aabb(inst, m)
	{
		let ang = 0;
		try { ang = inst.angle || 0; } catch (e) {}

		if (Math.abs(ang) <= 0.0001)
			return this._fullRect(inst, m);

		const w = Math.abs(inst.width);
		const h = Math.abs(inst.height);
		const lx0 = -m.ox * w, ly0 = -m.oy * h;
		const lx1 = lx0 + w, ly1 = ly0 + h;
		const c = Math.cos(ang), s = Math.sin(ang);
		const x = inst.x, y = inst.y;

		let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
		const corners = [[lx0, ly0], [lx1, ly0], [lx1, ly1], [lx0, ly1]];
		for (const [cx, cy] of corners)
		{
			const px = x + cx * c - cy * s;
			const py = y + cx * s + cy * c;
			if (px < l) l = px;
			if (py < t) t = py;
			if (px > r) r = px;
			if (py > b) b = py;
		}
		return [l, t, r, b];
	}

	_innerRect()
	{
		const bb = this.instance.getBoundingBox();
		const mg = this._margin;
		return [bb.left + mg, bb.top + mg, bb.right - mg, bb.bottom - mg];
	}

	_forEachTarget(cb)
	{
		for (const root of this._roots)
		{
			cb(root);

			try
			{
				for (const ch of root.allChildren())
					cb(ch);
			}
			catch (e) {}
		}
	}

	// ---------------------------------------------------------------
	// Main tick
	// ---------------------------------------------------------------
	_tick()
	{
		this._addListeners();

		if (this._pendingUids)
			this._resolvePendingUids();

		if (!this._didAutoAdd)
		{
			this._didAutoAdd = true;

			if (this._autoAddChildren)
			{
				try
				{
					for (const ch of Array.from(this.instance.children()))
						this._registerContent(ch);
				}
				catch (e) {}
			}
		}

		if (this._maskClass && this._clipMode === 1)
		{
			try { this._updateMask(this._innerRect()); }
			catch (e) {}
		}
		else if (this._maskClass && this._clipMode !== 1)
		{
			if (!this._warnedMaskInMesh)
			{
				this._warnedMaskInMesh = true;
				console.warn("[WindowScrollPanel] pannello uid=" + this.instance.uid +
					": azione 'Use as mask' ricevuta ma la proprieta' Clipping e' su Mesh. " +
					"La maschera viene ignorata: imposta Clipping = 'None (use a layer mask)' su questo pannello, " +
					"oppure rimuovi l'azione se questo pannello deve usare la modalita' Mesh.");
			}
			this._destroyMaskInstances();
		}

		if (this._maskClass || this._clipMode === 1)
		{
			this._diagAccum += (this.instance.dt || 0);
			if (this._diagAccum >= 2)
			{
				this._diagAccum = 0;
				this._logMaskDiagnostics();
			}
		}

		// Manual follow: content that could not join the hierarchy (e.g. some
		// plugin objects) is moved by hand when the panel itself moves
		try
		{
			const px = this.instance.x;
			const py = this.instance.y;

			if (this._lastPanelX !== null)
			{
				const pdx = px - this._lastPanelX;
				const pdy = py - this._lastPanelY;

				if (pdx !== 0 || pdy !== 0)
				{
					for (const root of this._roots)
					{
						try
						{
							if (typeof root.getParent === "function" && root.getParent() === this.instance)
								continue;		// hierarchy child: already moved by the scene graph
							root.offsetPosition(pdx, pdy);
						}
						catch (e) {}
					}
				}
			}

			this._lastPanelX = px;
			this._lastPanelY = py;
		}
		catch (e) {}

		if (this._roots.size === 0)
			return;

		let inner;
		try { inner = this._innerRect(); }
		catch (e) { return; }

		this._computeLimits(inner);
		this._clampTargets();
		this._updateScrollDisplay(this.instance.dt);
		this._clipAll(inner);
	}

	_computeLimits(inner)
	{
		let ul = Infinity, ut = Infinity, ur = -Infinity, ub = -Infinity;
		let any = false;

		this._forEachTarget(inst =>
		{
			const m = this._ensureMeta(inst);
			let rect;
			try { rect = this._aabb(inst, m); }
			catch (e) { return; }

			if (rect[0] < ul) ul = rect[0];
			if (rect[1] < ut) ut = rect[1];
			if (rect[2] > ur) ur = rect[2];
			if (rect[3] > ub) ub = rect[3];
			any = true;
		});

		if (!any)
		{
			this._minX = 0; this._maxX = 0;
			this._minY = 0; this._maxY = 0;
			this._contentW = 0; this._contentH = 0;
			return;
		}

		this._contentW = ur - ul;
		this._contentH = ub - ut;

		// Bounds of the content at scroll position 0, relative to the panel's inner rect
		const rel0Left = (ul - inner[0]) + this._dispX;
		const rel0Top = (ut - inner[1]) + this._dispY;
		const rel0Right = (ur - inner[2]) + this._dispX;
		const rel0Bottom = (ub - inner[3]) + this._dispY;

		if (this._direction === DIR_HORIZONTAL || this._direction === DIR_BOTH)
		{
			this._minX = Math.min(0, rel0Left);
			this._maxX = Math.max(0, rel0Right);
		}
		else
		{
			this._minX = 0; this._maxX = 0;
		}

		if (this._direction === DIR_VERTICAL || this._direction === DIR_BOTH)
		{
			this._minY = Math.min(0, rel0Top);
			this._maxY = Math.max(0, rel0Bottom);
		}
		else
		{
			this._minY = 0; this._maxY = 0;
		}
	}

	_clampTargets()
	{
		this._scrollX = clamp(this._scrollX, this._minX, this._maxX);
		this._scrollY = clamp(this._scrollY, this._minY, this._maxY);
	}

	_updateScrollDisplay(dt)
	{
		let nx, ny;

		if (this._smoothing > 0 && dt > 0)
		{
			const a = Math.min(1, dt * this._smoothing);
			nx = this._dispX + (this._scrollX - this._dispX) * a;
			ny = this._dispY + (this._scrollY - this._dispY) * a;

			if (Math.abs(this._scrollX - nx) < 0.05) nx = this._scrollX;
			if (Math.abs(this._scrollY - ny) < 0.05) ny = this._scrollY;
		}
		else
		{
			nx = this._scrollX;
			ny = this._scrollY;
		}

		const ddx = nx - this._dispX;
		const ddy = ny - this._dispY;

		if (ddx !== 0 || ddy !== 0)
		{
			this._dispX = nx;
			this._dispY = ny;

			for (const root of this._roots)
			{
				try { root.offsetPosition(-ddx, -ddy); }
				catch (e) {}
			}

			this._trigger(C3.Behaviors.ClaudeUI_WindowScrollPanel.Cnds.OnScrolled);
		}
	}

	_disableCollision(inst, m)
	{
		if (m.collOff)
			return;
		try
		{
			if (typeof inst.isCollisionEnabled === "boolean")
			{
				m.restoreColl = inst.isCollisionEnabled;
				inst.isCollisionEnabled = false;
				m.collOff = true;
			}
		}
		catch (e) {}
	}

	_restoreCollision(inst, m)
	{
		if (!m.collOff)
			return;
		try { inst.isCollisionEnabled = !!m.restoreColl; }
		catch (e) {}
		m.collOff = false;
	}

	// Used in layer-mask clip mode: only manage collisions, no visual clipping
	_collisionClipOne(inst, inner)
	{
		const m = this._ensureMeta(inst);

		let rect;
		try { rect = this._aabb(inst, m); }
		catch (e) { return; }

		const outside = rect[2] <= inner[0] || rect[3] <= inner[1] ||
			rect[0] >= inner[2] || rect[1] >= inner[3];

		if (outside)
			this._disableCollision(inst, m);
		else
			this._restoreCollision(inst, m);
	}

	_clipAll(inner)
	{
		if (this._clipMode === 1)
		{
			// Clipping handled externally by a layer mask; optionally manage collisions
			if (this._clicksInsideOnly)
				this._forEachTarget(inst => this._collisionClipOne(inst, inner));
			return;
		}

		this._forEachTarget(inst => this._clipOne(inst, inner));
	}

	_clipOne(inst, inner)
	{
		const m = this._ensureMeta(inst);

		let rect;
		try { rect = this._aabb(inst, m); }
		catch (e) { return; }

		const l = rect[0], t = rect[1], r = rect[2], b = rect[3];
		const pl = inner[0], pt = inner[1], pr = inner[2], pb = inner[3];

		const il = Math.max(l, pl);
		const it = Math.max(t, pt);
		const ir = Math.min(r, pr);
		const ib = Math.min(b, pb);

		// Fully outside the panel: hide
		if (ir <= il || ib <= it)
		{
			if (!m.hidden)
			{
				try
				{
					m.restoreVis = !!inst.isVisible;
					inst.isVisible = false;
				}
				catch (e) {}
				m.hidden = true;
			}
			if (this._clicksInsideOnly)
				this._disableCollision(inst, m);
			return;
		}

		// Restore the visibility the object had before we hid it
		if (m.hidden)
		{
			try { inst.isVisible = !!m.restoreVis; } catch (e) {}
			m.hidden = false;
		}

		this._restoreCollision(inst, m);

		// If the object is meant to be invisible, there is nothing to clip
		let visibleNow = true;
		try { visibleNow = !!inst.isVisible; } catch (e) {}
		if (!visibleNow)
		{
			if (m.meshed)
			{
				try { inst.releaseMesh(); } catch (e) {}
				m.meshed = false;
			}
			return;
		}

		const fullyInside = (l >= pl - EPS && t >= pt - EPS && r <= pr + EPS && b <= pb + EPS);

		let rotated = false;
		try { rotated = Math.abs(inst.angle) > 0.001; } catch (e) {}

		if (fullyInside || m.unsupported || rotated)
		{
			// No cropping needed (or not possible): remove any mesh we applied
			if (m.meshed)
			{
				try { inst.releaseMesh(); } catch (e) {}
				m.meshed = false;
			}
			return;
		}

		// Partially visible: crop with a 2x2 mesh so both geometry and texture
		// are reduced to the intersection rectangle
		const w = r - l;
		const h = b - t;
		if (w <= 0 || h <= 0)
			return;

		const fx0 = clamp((il - l) / w, 0, 1);
		const fy0 = clamp((it - t) / h, 0, 1);
		const fx1 = clamp((ir - l) / w, 0, 1);
		const fy1 = clamp((ib - t) / h, 0, 1);

		try
		{
			if (!m.meshed)
			{
				inst.createMesh(2, 2);
				m.meshed = true;
			}

			inst.setMeshPoint(0, 0, { mode: "absolute", x: fx0, y: fy0, u: fx0, v: fy0 });
			inst.setMeshPoint(1, 0, { mode: "absolute", x: fx1, y: fy0, u: fx1, v: fy0 });
			inst.setMeshPoint(0, 1, { mode: "absolute", x: fx0, y: fy1, u: fx0, v: fy1 });
			inst.setMeshPoint(1, 1, { mode: "absolute", x: fx1, y: fy1, u: fx1, v: fy1 });
		}
		catch (e)
		{
			// This object type doesn't support mesh distortion (e.g. Text):
			// fall back to show/hide clipping only
			m.unsupported = true;
			m.meshed = false;
			try { inst.releaseMesh(); } catch (e2) {}
		}
	}

	// ---------------------------------------------------------------
	// Layer mask management (Clipping = None setups)
	// ---------------------------------------------------------------
	setMaskObjectClass(objectClass)
	{
		this._maskClass = objectClass || null;

		if (!this._maskClass)
			this._destroyMaskInstances();
	}

	_isMaskInstance(inst)
	{
		return !!(this._maskInsts && this._maskInsts.indexOf(inst) >= 0);
	}

	_destroyMaskInstances()
	{
		if (!this._maskInsts)
			return;

		for (const mk of this._maskInsts)
		{
			if (mk)
			{
				try { mk.destroy(); } catch (e) {}
			}
		}
		this._maskInsts = null;
		this._maskGeo = null;
		this._maskTopRef = null;
	}

	_updateMask(inner)
	{
		// If the panel is invisible, its mask must vanish with it so the
		// layer behind the window shows through again
		let panelVisible = true;
		try { panelVisible = !!this.instance.isVisible; } catch (e) {}

		if (!panelVisible)
		{
			if (this._maskInsts && !this._maskHiddenByVis)
			{
				for (const mk of this._maskInsts)
				{
					if (mk)
					{
						try { mk.isVisible = false; } catch (e) {}
					}
				}
				this._maskHiddenByVis = true;
			}
			return;
		}

		if (this._maskHiddenByVis)
		{
			this._maskHiddenByVis = false;
			this._maskGeo = null;	// force a refresh, which restores strip visibility
		}

		// The mask works by ERASING the outside: four opaque strips with
		// 'destination-out' blend around the panel's view area. For efficiency
		// the strips are only touched when something actually changed: the
		// per-tick cost while the window is idle is a few number comparisons.
		let vl, vt, vr, vb;
		try
		{
			const vp = this.instance.layer.getViewport();
			const pad = 200;
			vl = vp.left - pad;
			vt = vp.top - pad;
			vr = vp.right + pad;
			vb = vp.bottom + pad;
		}
		catch (e)
		{
			vl = inner[0] - 5000; vt = inner[1] - 5000;
			vr = inner[2] + 5000; vb = inner[3] + 5000;
		}

		const geo = [inner[0], inner[1], inner[2], inner[3], vl, vt, vr, vb];

		let needGeo = !this._maskGeo;
		if (!needGeo)
		{
			for (let i = 0; i < 8; i++)
			{
				if (Math.abs(geo[i] - this._maskGeo[i]) > 0.5)
				{
					needGeo = true;
					break;
				}
			}
		}

		const allExist = !!(this._maskInsts &&
			this._maskInsts[0] && this._maskInsts[1] &&
			this._maskInsts[2] && this._maskInsts[3]);

		// Cheap z-order sanity check: the strips must still sit above the
		// window's topmost element (catches e.g. 'move to top' on the window)
		let needZ = !allExist;
		if (!needZ)
		{
			try
			{
				const t = this._maskTopRef;
				if (!t)
					needZ = true;
				else
				{
					const tz = t.zIndex;
					for (const mk of this._maskInsts)
					{
						if (mk.zIndex <= tz)
						{
							needZ = true;
							break;
						}
					}
				}
			}
			catch (e)
			{
				needZ = true;
			}
		}

		if (allExist && !needGeo && !needZ)
			return;		// nothing changed: no work this tick

		if (!this._maskInsts)
			this._maskInsts = [null, null, null, null];

		// left, right, top, bottom (corners covered by the side strips).
		// Strips bleed 1px INTO the view area so sub-pixel rounding can
		// never leave a sliver of content visible along the edges.
		const bleed = 1;
		const rects = [
			[vl, vt, inner[0] + bleed, vb],
			[inner[2] - bleed, vt, vr, vb],
			[inner[0], vt, inner[2], inner[1] + bleed],
			[inner[0], inner[3] - bleed, inner[2], vb]
		];

		const layer = this.instance.layer;
		const layerRef = (layer && typeof layer.index === "number") ? layer.index : 0;

		// Find the topmost instance belonging to this window (panel + content)
		// only when the z placement must be (re)done
		let topRef = null;
		if (needZ)
		{
			topRef = this.instance;
			let topZ = -Infinity;
			try { topZ = this.instance.zIndex; } catch (e) {}

			const consider = inst =>
			{
				try
				{
					if (this._isMaskInstance(inst))
						return;
					if (inst.layer && layer && inst.layer.index !== layer.index)
						return;
					const z = inst.zIndex;
					if (typeof z === "number" && z > topZ)
					{
						topZ = z;
						topRef = inst;
					}
				}
				catch (e) {}
			};

			// Registered content (and their children)...
			this._forEachTarget(consider);

			// ...plus the panel's entire scene-graph hierarchy, so unregistered
			// children (title bars, decorations) are also kept below the strips
			try
			{
				for (const ch of this.instance.allChildren())
					consider(ch);
			}
			catch (e) {}

			this._maskTopRef = topRef;
		}

		for (let i = 0; i < 4; i++)
		{
			let mk = this._maskInsts[i];
			let created = false;

			if (!mk)
			{
				try
				{
					mk = this._maskClass.createInstance(layerRef, 0, 0);
					this._maskInsts[i] = mk;
					created = true;

					if (!mk)
					{
						console.warn("[WindowScrollPanel] Mask strip could not be created on layer", layerRef);
						return;
					}
				}
				catch (e)
				{
					console.warn("[WindowScrollPanel] Failed to create mask strip:", e);
					this._maskClass = null;		// avoid spamming every tick
					return;
				}
			}

			try
			{
				if (needGeo || created)
				{
					const r = rects[i];
					const w = Math.max(0, r[2] - r[0]);
					const h = Math.max(0, r[3] - r[1]);
					mk.x = (r[0] + r[2]) / 2;
					mk.y = (r[1] + r[3]) / 2;
					mk.width = w;
					mk.height = h;
					mk.isVisible = (w > 0.5 && h > 0.5);
				}

				if ((needZ || created) && topRef)
				{
					// Immediately above the window's topmost element: content
					// below is clipped, anything above is unaffected
					if (typeof mk.moveAdjacentToInstance === "function")
						mk.moveAdjacentToInstance(topRef, true);
					else
						mk.moveToTop();
					topRef = mk;

					// Enforce the erasing blend via script so the editor
					// setting cannot be a silent point of failure
					if (typeof mk.blendMode === "string" && mk.blendMode !== "destination-out")
						mk.blendMode = "destination-out";
				}
			}
			catch (e)
			{
				this._maskInsts[i] = null;
			}
		}

		this._maskGeo = geo;
	}

	_logMaskDiagnostics()
	{
		try
		{
			const pl = this.instance.layer;
			const masks = this._maskInsts ? this._maskInsts.filter(m => !!m) : [];
			const first = masks.length ? masks[0] : null;
			const probe = {};
			if (pl)
			{
				for (const k of ["isForceOwnTexture", "forceOwnTexture", "isOwnTexture", "isTransparent", "blendMode"])
					probe[k] = (typeof pl[k] === "undefined") ? "(non esiste)" : pl[k];
			}
			const diag = {
				panelLayerName: pl ? pl.name : "?",
				panelLayerIndex: pl ? pl.index : "?",
				clipMode: this._clipMode === 1 ? "none (mask)" : "mesh",
				maskAssigned: !!this._maskClass,
				maskStripsCreated: masks.length + "/4",
				maskLayerIndex: (first && first.layer) ? first.layer.index : "n/a",
				maskBlendMode: first ? ((typeof first.blendMode === "string") ? first.blendMode : "(non esposto dall'API)") : "n/a",
				registeredContent: this._roots.size,
				layerProbe: probe
			};
			console.log("[WindowScrollPanel] DIAGNOSTICA pannello uid=" + this.instance.uid +
				" — incolla queste righe a Claude:\n" + JSON.stringify(diag, null, 2));
		}
		catch (e) {}
	}

	// ---------------------------------------------------------------
	// Save / load
	// ---------------------------------------------------------------
	_saveToJson()
	{
		const uids = [];
		for (const inst of this._roots)
		{
			try { uids.push(inst.uid); }
			catch (e) {}
		}

		return {
			"sx": this._scrollX,
			"sy": this._scrollY,
			"dx": this._dispX,
			"dy": this._dispY,
			"mg": this._margin,
			"we": this._wheelEnabled,
			"uids": uids
		};
	}

	_loadFromJson(o)
	{
		this._scrollX = o["sx"] || 0;
		this._scrollY = o["sy"] || 0;
		this._dispX = o["dx"] || 0;
		this._dispY = o["dy"] || 0;
		this._margin = o["mg"] || 0;
		this._wheelEnabled = !!o["we"];

		this._roots.clear();
		this._meta.clear();
		this._pendingUids = o["uids"] || [];
	}

	_resolvePendingUids()
	{
		const uids = this._pendingUids;
		this._pendingUids = null;

		if (!uids || !this.runtime)
			return;

		for (const uid of uids)
		{
			try
			{
				const inst = this.runtime.getInstanceByUid(uid);
				if (inst)
				{
					this._roots.add(inst);
					this._ensureMeta(inst);
				}
			}
			catch (e) {}
		}
	}

	// ---------------------------------------------------------------
	// Public script API (also used by ACEs)
	// ---------------------------------------------------------------
	get scrollX()
	{
		return this._scrollX;
	}

	set scrollX(v)
	{
		if (typeof v !== "number" || !isFinite(v))
			return;
		this._scrollX = clamp(v, this._minX, this._maxX);
	}

	get scrollY()
	{
		return this._scrollY;
	}

	set scrollY(v)
	{
		if (typeof v !== "number" || !isFinite(v))
			return;
		this._scrollY = clamp(v, this._minY, this._maxY);
	}

	get minScrollX() { return this._minX; }
	get maxScrollX() { return this._maxX; }
	get minScrollY() { return this._minY; }
	get maxScrollY() { return this._maxY; }

	get contentWidth() { return this._contentW; }
	get contentHeight() { return this._contentH; }

	get viewWidth()
	{
		return Math.max(0, Math.abs(this.instance.width) - 2 * this._margin);
	}

	get viewHeight()
	{
		return Math.max(0, Math.abs(this.instance.height) - 2 * this._margin);
	}

	get fractionX()
	{
		const range = this._maxX - this._minX;
		return range > 0 ? (this._scrollX - this._minX) / range : 0;
	}

	set fractionX(f)
	{
		if (typeof f !== "number" || !isFinite(f))
			return;
		f = clamp(f, 0, 1);
		this._scrollX = this._minX + (this._maxX - this._minX) * f;
	}

	get fractionY()
	{
		const range = this._maxY - this._minY;
		return range > 0 ? (this._scrollY - this._minY) / range : 0;
	}

	set fractionY(f)
	{
		if (typeof f !== "number" || !isFinite(f))
			return;
		f = clamp(f, 0, 1);
		this._scrollY = this._minY + (this._maxY - this._minY) * f;
	}

	get thumbFractionX()
	{
		const total = this.viewWidth + (this._maxX - this._minX);
		return total > 0 ? clamp(this.viewWidth / total, 0.05, 1) : 1;
	}

	get thumbFractionY()
	{
		const total = this.viewHeight + (this._maxY - this._minY);
		return total > 0 ? clamp(this.viewHeight / total, 0.05, 1) : 1;
	}

	get margin() { return this._margin; }

	set margin(v)
	{
		if (typeof v === "number" && isFinite(v))
			this._margin = Math.max(0, v);
	}

	get isWheelEnabled() { return this._wheelEnabled; }
	set isWheelEnabled(e) { this._wheelEnabled = !!e; }

	get canScrollVertically() { return (this._maxY - this._minY) > 0; }
	get canScrollHorizontally() { return (this._maxX - this._minX) > 0; }

	addContentInstance(inst)
	{
		this._registerContent(inst);
	}

	removeContentInstance(inst)
	{
		this._unregisterContent(inst);
	}

	refresh()
	{
		// Re-measure everything: release meshes and drop cached metadata
		for (const inst of Array.from(this._meta.keys()))
			this._restoreInstance(inst);

		this._meta.clear();

		for (const root of this._roots)
			this._ensureMeta(root);
	}
};

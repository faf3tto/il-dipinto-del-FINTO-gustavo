
const C3 = globalThis.C3;
C3.Plugins.Custom_LayerInteractivity.Acts =
{
	IsolateInteractive(layer) { this.isolateInteractive(layer); },
	IsolateNonInteractive(layer) { this.isolateNonInteractive(layer); },
	SetAllInteractive(v) { this.setAllInteractive(v !== 0); },
	SetLayerInteractive(layer, v) { this.setLayerInteractive(layer, v !== 0); }
};

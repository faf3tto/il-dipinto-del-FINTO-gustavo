
const C3 = globalThis.C3;

function getInstancesFromObjectParam(objectClass)
{
	if (!objectClass)
		return [];

	let insts = null;

	try { insts = objectClass.getPickedInstances(); }
	catch (e) {}

	if (!insts || insts.length === 0)
	{
		try { insts = objectClass.getAllInstances(); }
		catch (e) {}
	}

	return insts || [];
}

C3.Behaviors.ClaudeUI_WindowScrollPanel.Acts =
{
	AddContent(objectClass)
	{
		for (const inst of getInstancesFromObjectParam(objectClass))
			this.addContentInstance(inst);
	},

	RemoveContent(objectClass)
	{
		for (const inst of getInstancesFromObjectParam(objectClass))
			this.removeContentInstance(inst);
	},

	ScrollTo(x, y)
	{
		this.scrollX = x;
		this.scrollY = y;
	},

	ScrollBy(dx, dy)
	{
		this.scrollX = this.scrollX + dx;
		this.scrollY = this.scrollY + dy;
	},

	SetScrollX(x)
	{
		this.scrollX = x;
	},

	SetScrollY(y)
	{
		this.scrollY = y;
	},

	SetFractionX(f)
	{
		this.fractionX = f;
	},

	SetFractionY(f)
	{
		this.fractionY = f;
	},

	SetMargin(m)
	{
		this.margin = m;
	},

	SetWheelEnabled(e)
	{
		this.isWheelEnabled = e;
	},

	Refresh()
	{
		this.refresh();
	},

	SetMask(objectClass)
	{
		this.setMaskObjectClass(objectClass);
	}
};

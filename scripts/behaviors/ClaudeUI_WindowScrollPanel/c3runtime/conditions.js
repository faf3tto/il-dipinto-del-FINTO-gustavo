
const C3 = globalThis.C3;

C3.Behaviors.ClaudeUI_WindowScrollPanel.Cnds =
{
	OnScrolled()
	{
		return true;
	},

	CanScrollVertically()
	{
		return this.canScrollVertically;
	},

	CanScrollHorizontally()
	{
		return this.canScrollHorizontally;
	}
};

using UnrealBuildTool;

public class BatteryPlantEditorTarget : TargetRules
{
	public BatteryPlantEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("BatteryPlant");
	}
}

using UnrealBuildTool;

public class BatteryPlantTarget : TargetRules
{
	public BatteryPlantTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("BatteryPlant");
	}
}

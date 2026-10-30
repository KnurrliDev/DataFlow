#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "BatteryActor.generated.h"

UENUM()
enum class EChargeState : uint8
{
	Idle,
	Planning,
	Charging,
	Full
};

/** A home battery that plans its charge from the price of each hour. */
UCLASS()
class BATTERYPLANT_API ABatteryActor : public AActor
{
	GENERATED_BODY()

public:
	ABatteryActor();

	virtual void Tick(float DeltaSeconds) override;

	/** Plans the charge for the next hours. Returns the number of hours with a charge. */
	UFUNCTION(BlueprintCallable, Category = "Battery")
	int32 PlanCharge(const TArray<float>& Prices);

	UPROPERTY(EditAnywhere, Category = "Battery")
	float Capacity = 10.f;

	UPROPERTY(VisibleAnywhere, Category = "Battery")
	float Charge = 0.f;

private:
	float CheapestPrice(const TArray<float>& Prices) const;

	EChargeState State = EChargeState::Idle;
	TMap<int32, float> PlannedHours;
	bool bIsPlanDirty = true;
};

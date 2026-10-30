#include "BatteryActor.h"
#include "Async/Async.h"

ABatteryActor::ABatteryActor()
{
	PrimaryActorTick.bCanEverTick = true;
}

void ABatteryActor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	switch (State)
	{
	case EChargeState::Idle:
		if (bIsPlanDirty)
		{
			State = EChargeState::Planning;
		}
		break;
	case EChargeState::Planning:
	{
		const TArray<float> Prices = { 0.31f, 0.22f, 0.18f, 0.27f };
		// the plan runs on a worker thread, and the result comes back to the game thread
		Async(EAsyncExecution::ThreadPool, [this, Prices]()
		{
			const int32 Hours = PlanCharge(Prices);
			AsyncTask(ENamedThreads::GameThread, [this, Hours]()
			{
				State = Hours > 0 ? EChargeState::Charging : EChargeState::Idle;
			});
		});
		bIsPlanDirty = false;
		break;
	}
	case EChargeState::Charging:
		Charge = FMath::Min(Capacity, Charge + DeltaSeconds);
		if (Charge >= Capacity)
		{
			State = EChargeState::Full;
		}
		break;
	case EChargeState::Full:
		break;
	}
}

int32 ABatteryActor::PlanCharge(const TArray<float>& Prices)
{
	const float Limit = CheapestPrice(Prices) * 1.2f;
	PlannedHours.Reset();
	for (int32 Hour = 0; Hour < Prices.Num(); ++Hour)
	{
		if (Prices[Hour] <= Limit)
		{
			PlannedHours.Add(Hour, Prices[Hour]);
		}
	}
	if (PlannedHours.Contains(0))
	{
		UE_LOG(LogTemp, Log, TEXT("The battery charges now at %f"), PlannedHours[0]);
	}
	return PlannedHours.Num();
}

float ABatteryActor::CheapestPrice(const TArray<float>& Prices) const
{
	float Cheapest = TNumericLimits<float>::Max();
	for (const float Price : Prices)
	{
		Cheapest = FMath::Min(Cheapest, Price);
	}
	return Cheapest;
}

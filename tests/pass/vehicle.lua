-- Valid nanos-world vehicle script with SetEngineSetup
local spawn_loc = Vector(100, 200, 50)
local spawn_rot = Rotator(0, 0, 0)
local my_vehicle = VehicleWheeled(spawn_loc, spawn_rot, "nanos-world::SM_Jeep")

my_vehicle:SetEngineStarted(true)
my_vehicle:SetHeadlightsEnabled(true)

-- Test SetEngineSetup with valid parameters
my_vehicle:SetEngineSetup(700, 5700, 1200, 0.05, 5, 600, {
    [0] = 0.0,
    [1140] = 0.9,
    [2280] = 1.0,
    [4560] = 0.8,
    [5700] = 0.0,
})


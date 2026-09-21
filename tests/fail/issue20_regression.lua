-- Regression test for Issue #20:
-- SetEngineSetup was losing its annotations because of unescaped multiline table values.
-- Calling it with invalid type "wrong" instead of integer must trigger param-type-mismatch.
local veh = VehicleWheeled(Vector(0, 0, 0), Rotator(0, 0, 0), "nanos-world::SM_Jeep")
veh:SetEngineSetup("wrong", 5700, 1200, 0.05, 5, 600, {})


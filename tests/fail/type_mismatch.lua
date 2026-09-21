-- Invalid: parameter type mismatch
local char = Character(Vector(0, 0, 0), Rotator(0, 0, 0), "nanos-world::SK_Mannequin")
char:SetSpeedMultiplier("not_a_number")


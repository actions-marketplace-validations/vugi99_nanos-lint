-- Invalid: undefined field on Character
local char = Character(Vector(0, 0, 0), Rotator(0, 0, 0), "nanos-world::SK_Mannequin")
char:CompletelyFakeMethod()


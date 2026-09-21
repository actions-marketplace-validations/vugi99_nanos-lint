-- Valid nanos-world character script
local spawn_location = Vector(0, 0, 100)
local spawn_rotation = Rotator(0, 90, 0)
local my_character = Character(spawn_location, spawn_rotation, "nanos-world::SK_Mannequin")

my_character:SetSpeedMultiplier(1.2)
my_character:SetHealth(100)

local health = my_character:GetHealth()
if health > 50 then
    my_character:SetInvulnerable(false)
end


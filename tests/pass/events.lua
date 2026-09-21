-- Valid nanos-world events script
Package.Subscribe("Load", function()
    local name = Package.GetName()
    print("Package loaded: " .. name)
end)

Events.Subscribe("PlayerSpawn", function(character)
    character:SetSpeedMultiplier(1.0)
end)


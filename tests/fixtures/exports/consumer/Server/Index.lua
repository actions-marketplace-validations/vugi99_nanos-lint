-- Valid consumer: both globals are exported by the dependency package.
Package.Subscribe("Load", function()
    ExportsLibraryPerms.LoadPlayer(Player.GetAll()[1])
    Console.Log("loaded: " .. tostring(ExportsLibraryPerms.GetLoadedCount()))
    ExportsLibraryNoise.Play(1)
    Console.Log("noise: " .. tostring(ExportsLibraryNoise.Count()))
end)

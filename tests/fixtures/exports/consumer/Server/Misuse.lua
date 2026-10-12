-- Invalid consumer: exported globals must keep their real shape and signatures.
Package.Subscribe("Load", function()
    ExportsLibraryPerms.ThisDoesNotExist()
    ExportsLibraryPerms.LoadPlayer("not a player")
    ExportsLibraryNoise.NotAFunction()
    ExportsLibraryNoise.Play("not an integer")
end)

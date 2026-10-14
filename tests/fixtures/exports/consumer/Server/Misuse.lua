-- Invalid consumer: exported globals must keep their real shape and signatures.
Package.Subscribe("Load", function()
    ExportsLibraryPerms.ThisDoesNotExist()
    ExportsLibraryPerms.LoadPlayer("not a player")
    ExportsLibraryNoise.NotAFunction()
    ExportsLibraryNoise.Play("not an integer")
    -- Exports of inline-function and spaced spellings keep their shape and signatures too.
    ExportsLibraryClosures.NotAFunction()
    ExportsLibraryPair(1)
    ExportsLibrarySpaced.NotAFunction()
    ExportsLibrarySpaced.Play("not an integer")
    ExportsLibraryScalar.NotAFunction()
end)

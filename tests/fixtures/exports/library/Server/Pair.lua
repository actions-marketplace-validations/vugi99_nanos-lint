-- Two documented results must survive the mirroring, so consumers see the real return types (#73).
Package.Export("ExportsLibraryPair", function()
    ---@return integer
    ---@return string
    return 1, "two"
end)

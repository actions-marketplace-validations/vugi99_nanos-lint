-- The exported expression is a closure whose body holds commas of its own, so a scan that splits
-- the Package.Export arguments on them would truncate the body and break the generated library (#73).
Package.Export("ExportsLibraryClosures", function()
    local first, second = 1, "two"
    return first, second
end)

-- A later export in the same script must keep resolving as well (#73).
local Scalar = {}

---@return integer
function Scalar.Count() return 0 end

Package.Export("ExportsLibraryScalar", Scalar)

---@class ExportsLibraryAuthoring
---@field Permissions table
---@field Version integer
-- The exported value is a multi-line table with no trailing comma before the closing brace:
-- a scan that mistakes commas inside the table for argument separators would truncate it (#73).
Package.Export("ExportsLibraryAuthoring", {
    Permissions = {},
    Version = 1
})

---@class ExportsLibraryNoise
local Noise = {}

---@param id integer
function Noise.Play(id) end

---@return integer
function Noise.Count() return 0 end

Package.Export("ExportsLibraryNoise", Noise)

local AuthorizationLifecycle = Package.Require("AuthorizationLifecycle.lua")

local lifecycle = AuthorizationLifecycle.New()

local VPerms = lifecycle.VPerms

Package.Export("ExportsLibraryPerms", VPerms)

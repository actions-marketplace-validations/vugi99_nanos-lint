-- Invalid: syntax error in Lua
function broken_function()
    if true then
        local x = 123
    -- missing end
end


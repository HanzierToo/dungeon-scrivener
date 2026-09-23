local function main()
  local trust = api.read({kind = "world"}, "trust")
  api.request({
    kind = "set-state",
    target = {scope = {kind = "world"}, key = "trust"},
    value = trust + 1
  })
  api.emit("midnight-chime", {minute = 2})
end

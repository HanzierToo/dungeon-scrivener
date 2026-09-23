function main() {
  const echoes = api.randomInt(1, 3);
  api.request({
    kind: "increment-state",
    target: {scope: {kind: "world"}, key: "bell-echoes"},
    amount: echoes
  });
  api.emit("tavern-stir", {source: "midnight-chime"});
}

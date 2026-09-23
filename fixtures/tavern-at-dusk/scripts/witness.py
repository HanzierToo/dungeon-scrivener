def main():
    if not api.hasTag("cellar-rowan", "startled"):
        api.request({"kind": "add-tag", "entityId": "cellar-rowan", "tag": "startled"})

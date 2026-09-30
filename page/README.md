# The agreement page

One static page for the NFT owner and the host. It reads the vault through the connected wallet, reads IMD's open swarm listing for the seat, shows one next action, and asks the wallet to sign exactly the call it shows. No backend, no account, nothing stored anywhere but the browser (the selected vault, the pasted strings, the owner's mined approval and registration, unresolved and resolved transactions, a short history).

```
cd page
npm install
npm run build        # writes dist/ with the constants of config.json baked in
```

`dist/` is committed and is what gets published: any static host serves it (GitHub Pages, IPFS through a gateway, a plain web server). Open `dist/index.html` from a web server, not as a local file: wallets do not inject into `file://` pages.

`config.json` holds the chain constants: chain id, factory and its deployment block, collection, reward token, registrar, relay, IMD's API origin (used only for the open `/swarm` route). Change it and rebuild; CI checks that `dist/` matches the sources and the config.

## What the owner does

| Moment | Button | Wallet confirmations |
| --- | --- | --- |
| Start | Paste the host's hosting offer, type the seat id, Create the vault. Send the vault address to the host. | 1 |
| Deposit | Move my NFT into the vault (one safe transfer straight into the vault) | 1 |
| Pair | Paste the host's pairing string, Approve the pairing, inside the code's five minutes | 1 |
| Register | Register the agent, only when the seat has no usable agent yet (the registration travels inside the pairing string and is kept by the page, so it stays reachable after the code's five minutes) | 1 |
| Later | Claim my rewards, Take my NFT back | 1 each |

The host sees the same page with the same vault and gets Claim for the host share, also after the owner has taken the NFT back.

What the page shows as done is the owner's side: IMD's open listing appears as information (the seat, its agent, its work counts), and whether the new device is actually paired is the host's confirmation, not the page's. An old listing never skips the pairing; an existing agent can only skip the registration, and only when the registrar confirms this vault controls an agent bound to exactly this seat.

## Checks the page makes before asking the wallet

An address, pasted or restored from the browser's record, is accepted only after the factory confirms it created it (its list of vaults, or its `VaultCreated` logs); a contract that merely answers like a vault is refused, so the NFT can only ever be sent to the factory's own code. The hosting offer must be for this chain, relay and collection, with an operator different from the provider. The pairing string must be for this vault, this seat, the vault's device key, the agreed relay and chain, with a digest that the vault itself computes for that message and both deadlines still ahead; its registration intent must target the pinned registrar with the ERC-721 standard, this collection and this seat, and is kept apart from the string with its own checks. Every transaction is shown with its target and calldata before the wallet is asked, and right before the wallet is asked the page re-reads the chain and the account and refuses if either, the vault or the call differ from what the dialog showed. Tabs share one record: every save merges what another tab wrote, an approval or a registration is refused while an earlier one for the vault is unresolved, tabs take turns per vault through the Web Locks API (held from before the wallet request until the hash is recorded, released when the tab closes, never time-based; this needs https or localhost), and a browser that refuses to store the record cannot send an approval at all. A mined transaction becomes a record in one place: its receipt and the mined transaction are checked against the operation recorded at send time (hash, target, calldata), success reconstructs the approval or the registration for that operation's own vault, and the hash is resolved for every tab, whether the sending tab saw the receipt or another tab found it after a reload. A tab closed while its wallet prompt was open leaves no hash; the approval of exactly the pasted string's digest, live on the vault, is then recorded from the chain so it survives the string's deadlines.

## Development

The page is built from the host helper's library (`../host/lib`) with a pinned bundler (esbuild) and a pinned viem (the build resolves viem from `page/node_modules` whatever else is installed, so the committed bundle is reproducible from any layout); no script is loaded at runtime from anywhere. The logic it relies on, offer validation, the step machine and the calldata builders, is what the host helper's tests run end to end against a local chain and a fake IMD (`cd ../host && npm test`).

`npm test` here runs the guard unit tests (record merging across tabs, the signing context, the lock) and, when Playwright is installed (`npx playwright install chromium`) or Chrome is on the machine, the committed bundle in a real browser against a simulated wallet and chain, with every other request aborted: a foreign contract refused as a vault (pasted or restored), a chain change between the review and the wallet request, two tabs and one approval with the mined hash leaving the ledger in both, a reverted approval retried, a page closed before its approval or registration mined and recovered from the receipt past every deadline, a wallet prompt left open blocking another tab for as long as it is open, a tab closed during its prompt recovered from the vault's own approval, storage that refuses writes, an old listing that must not skip the pairing, and a registration after the pairing code expired. CI runs both.

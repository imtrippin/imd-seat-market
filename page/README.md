# The agreement page

One static page for the NFT owner and the host. It reads the vault through the connected wallet, reads IMD's open swarm listing for the seat, shows one next action, and asks the wallet to sign exactly the call it shows. No backend, no account, nothing stored anywhere but the browser (the selected vault, the pasted strings, unresolved approvals, a short history).

```
cd page
npm install
npm run build        # writes dist/ with the constants of config.json baked in
```

`dist/` is committed and is what gets published: any static host serves it (GitHub Pages, IPFS through a gateway, a plain web server). Open `dist/index.html` from a web server, not as a local file: wallets do not inject into `file://` pages.

`config.json` holds the chain constants: chain id, factory, collection, reward token, registrar, relay, IMD's API origin (used only for the open `/swarm` route). Change it and rebuild; CI checks that `dist/` matches the sources and the config.

## What the owner does

| Moment | Button | Wallet confirmations |
| --- | --- | --- |
| Start | Paste the host's hosting offer, type the seat id, Create the vault. Send the vault address to the host. | 1 |
| Deposit | Move my NFT into the vault (one safe transfer straight into the vault) | 1 |
| Pair | Paste the host's pairing string, Approve the pairing, inside the code's five minutes | 1 |
| Register | Register the agent, only when the seat has no usable agent yet (the registration travels inside the pairing string) | 1 |
| Later | Claim my rewards, Take my NFT back | 1 each |

The host sees the same page with the same vault and gets Claim for the host share, also after the owner has taken the NFT back.

## Checks the page makes before asking the wallet

The hosting offer must be for this chain, relay and collection, with an operator different from the provider. The pairing string must be for this vault, this seat, the vault's device key, the agreed relay and chain, with a digest that the vault itself computes for that message and both deadlines still ahead; its registration intent must target the pinned registrar with the ERC-721 standard, this collection and this seat. A second approval is refused while an earlier one is unresolved. Every transaction is shown with its target and calldata before the wallet is asked.

## Development

The page is built from the host helper's library (`../host/lib`) with a pinned bundler (esbuild) and a pinned viem; no script is loaded at runtime from anywhere. The logic it relies on, offer validation, the step machine and the calldata builders, is what the host helper's tests run end to end against a local chain and a fake IMD (`cd ../host && npm test`).

export function roomMessage({ service, chainId, vault, account, role, nonce, until }) {
  return `Seat setup room sign-in\nService: ${service}\nChain: ${chainId}\nVault: ${vault.toLowerCase()}\nAccount: ${account.toLowerCase()}\nRole: ${role}\nNonce: ${nonce}\nExpires: ${new Date(until).toISOString()}\nThis signs you into a setup room only. It authorizes no transaction, pairing, token transfer or payment.`;
}

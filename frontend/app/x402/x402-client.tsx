"use client";

import { useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useWalletClient
} from "wagmi";
import { base } from "wagmi/chains";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import {
  registerExactEvmScheme,
  type ClientEvmSigner
} from "@x402/evm/exact/client";
import type { WalletClient } from "viem";

const apiBase =
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3000";
const endpoint = `${apiBase}/x402/one-time`;

function wagmiToClientSigner(walletClient: WalletClient): ClientEvmSigner {
  const address = walletClient.account?.address;
  if (!address) {
    throw new Error("Wallet account not available.");
  }
  return {
    getAddress: async () => address,
    signTypedData: (typedData) => walletClient.signTypedData(typedData as any),
    sendTransaction: (tx) => walletClient.sendTransaction(tx as any)
  };
}

export function X402Client() {
  const { address, isConnected, chain } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const isOnBase = chain?.id === base.id;
  const walletConnectMissing = useMemo(
    () => !process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
    []
  );

  const handlePaywalledCall = async () => {
    if (!walletClient) {
      setError("Please connect a wallet first.");
      setStatus("error");
      return;
    }

    setStatus("loading");
    setError(null);
    setResult(null);

    try {
      const client = x402Client();
      registerExactEvmScheme(client, {
        signer: wagmiToClientSigner(walletClient)
      });
      const fetchWithPayment = wrapFetchWithPayment(fetch, client);

      const response = await fetchWithPayment(endpoint, {
        method: "GET",
        credentials: "include"
      });
      const payload = await response
        .json()
        .catch(() => ({ error: `HTTP ${response.status}` }));

      if (!response.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }

      setResult(payload);
      setStatus("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
      setStatus("error");
    }
  };

  return (
    <div className="x402-body">
      <div className="x402-panel">
        <div className="card-title">Wallet</div>
        {isConnected ? (
          <div className="wallet-info">
            <div>Connected: {address}</div>
            <div>Network: {chain?.name || "Unknown"}</div>
            <button onClick={() => disconnect()}>Disconnect</button>
          </div>
        ) : (
          <div className="wallet-actions">
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                onClick={() => connect({ connector })}
                disabled={isConnecting}
              >
                Connect {connector.name}
              </button>
            ))}
          </div>
        )}
        {walletConnectMissing ? (
          <div className="hint">
            WalletConnect needs `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to be set
            in the frontend environment.
          </div>
        ) : null}
      </div>

      <div className="x402-panel">
        <div className="card-title">Call API</div>
        <div className="hint">
          Endpoint: {endpoint}
        </div>
        {!isOnBase && isConnected ? (
          <button
            onClick={() => switchChain({ chainId: base.id })}
            disabled={isSwitching}
          >
            Switch to Base
          </button>
        ) : null}
        <button
          onClick={handlePaywalledCall}
          disabled={!isConnected || !isOnBase || status === "loading"}
        >
          Pay 0.001 USDC & Call
        </button>
        {status === "loading" ? (
          <div className="hint">Waiting for wallet signature and payment...</div>
        ) : null}
        {status === "success" ? (
          <pre>{JSON.stringify(result, null, 2)}</pre>
        ) : null}
        {status === "error" ? (
          <div className="error">{error}</div>
        ) : null}
      </div>
    </div>
  );
}

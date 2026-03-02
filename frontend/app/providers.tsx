"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { baseSepolia, polygon } from "wagmi/chains";

const connectors = [
  // Pin to MetaMask to avoid EIP-6963 extension-selection issues from generic injected().
  injected({ target: "metaMask" })
];

const config = createConfig({
  chains: [baseSepolia, polygon],
  connectors,
  transports: {
    [baseSepolia.id]: http(),
    [polygon.id]: http("https://polygon.drpc.org")
  }
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

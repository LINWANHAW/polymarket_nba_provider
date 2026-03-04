"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
  useWalletClient
} from "wagmi";
import { baseSepolia, polygon } from "wagmi/chains";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { erc20Abi, formatUnits } from "viem";

const resolveApiBase = () => {
  if (process.env.NEXT_PUBLIC_API_BASE) {
    return process.env.NEXT_PUBLIC_API_BASE;
  }
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:3000`;
  }
  return "http://localhost:3000";
};
const apiBase = resolveApiBase();
const analysisEndpoint = `${apiBase}/nba/analysis`;
const analysisFreeEndpoint = `${apiBase}/nba/analysis/free`;
const analysisLogEndpoint = `${apiBase}/nba/analysis-log`;
const bazaarResourcesEndpoint = `${apiBase}/x402/bazaar/resources`;
const usdcTokenByChainId = {
  [baseSepolia.id]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  [polygon.id]: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
} as const;
const usdcDecimals = 6;
const zeroAddress = "0x0000000000000000000000000000000000000000" as const;
const supportedPaidChainIds = new Set<number>([baseSepolia.id, polygon.id]);

type HexAddress = `0x${string}`;

function formatTokenAmount(value: string | null) {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  });
}

type PaidStatus = "idle" | "loading" | "success" | "error";

type PaidState = {
  status: PaidStatus;
  result: any;
  error: string | null;
  paymentRequiredData: PaymentRequired | null;
  paymentRequiredHeader: string | null;
  paymentRequiredBody: any | null;
  paymentResponseHeader: string | null;
  paymentSettleResponse: any | null;
  paidResponseInfo: {
    status: number;
    body: any;
    headers: Record<string, string>;
  } | null;
};

type PaidRequestParams = {
  endpoint: string;
  method: string;
  body?: Record<string, any>;
  walletClient: any;
  address?: string | null;
  chainId?: number | null;
};

type AnalysisLogItem = {
  id: string;
  payerAddress: string | null;
  sessionId: string | null;
  txHash: string | null;
  chainId: number | null;
  requestParams: Record<string, any>;
  response: Record<string, any> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type AnalysisLogState = {
  status: PaidStatus;
  data: AnalysisLogItem[];
  page: number;
  pageSize: number;
  total: number;
  error: string | null;
};

type BazaarResourceItem = {
  resource?: string;
  type?: string;
  x402Version?: number;
  accepts?: Array<{
    network?: string;
    amount?: string;
    asset?: string;
  }>;
  lastUpdated?: number;
  metadata?: Record<string, any>;
};

type BazaarState = {
  status: PaidStatus;
  items: BazaarResourceItem[];
  total: number;
  error: string | null;
};

const emptyPaidState: PaidState = {
  status: "idle",
  result: null,
  error: null,
  paymentRequiredData: null,
  paymentRequiredHeader: null,
  paymentRequiredBody: null,
  paymentResponseHeader: null,
  paymentSettleResponse: null,
  paidResponseInfo: null
};

const emptyAnalysisLogState: AnalysisLogState = {
  status: "idle",
  data: [],
  page: 1,
  pageSize: 20,
  total: 0,
  error: null
};

const emptyBazaarState: BazaarState = {
  status: "idle",
  items: [],
  total: 0,
  error: null
};

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function toReceiptMatchup(item: AnalysisLogItem) {
  const date =
    typeof item.requestParams?.date === "string" ? item.requestParams.date : "";
  const home =
    typeof item.requestParams?.home === "string" ? item.requestParams.home : "";
  const away =
    typeof item.requestParams?.away === "string" ? item.requestParams.away : "";
  const matchup = home && away ? `${away}@${home}` : "N/A";
  return date ? `${date} ${matchup}` : matchup;
}

function toReceiptSummary(item: AnalysisLogItem) {
  if (item.error) {
    return `Failed: ${item.error}`;
  }
  const text =
    typeof item.response?.analysis === "string" ? item.response.analysis : "";
  if (!text) {
    return "Success";
  }
  return text;
}

function formatTxHash(value: string | null | undefined) {
  if (!value) {
    return "-";
  }
  return value;
}

function formatConfidence(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }
  return `${numeric.toFixed(1)}%`;
}

function formatUnixSeconds(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return formatTimestamp(new Date((value as number) * 1000).toISOString());
}

async function performPaidRequest(
  params: PaidRequestParams
): Promise<PaidState> {
  const { endpoint, method, body, walletClient, address, chainId } = params;
  const signingAddress = (walletClient?.account?.address || address) as
    | HexAddress
    | undefined;
  if (!walletClient) {
    throw new Error("Please connect a wallet first.");
  }
  if (!signingAddress) {
    throw new Error("Missing wallet address.");
  }

  const signer = {
    address: signingAddress,
    signTypedData: (typedData: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) =>
      walletClient.signTypedData({
        ...typedData,
        account: signingAddress
      })
  };

  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const httpClient = new x402HTTPClient(client);

  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  if (typeof chainId === "number" && Number.isInteger(chainId) && chainId > 0) {
    headers["X-CHAIN-ID"] = String(chainId);
  }
  let requestBody: string | undefined;
  if (body && method.toUpperCase() !== "GET") {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const parseResponseBody = async (response: Response): Promise<any> => {
    const responseText = await response.text();
    if (!responseText) {
      return {};
    }
    try {
      return JSON.parse(responseText);
    } catch {
      return { raw: responseText };
    }
  };

  const collectDebugHeaders = (
    response: Response,
    additional?: Record<string, string>
  ) => {
    const next: Record<string, string> = {};
    const debugHeaderNames = [
      "payment-required",
      "payment-response",
      "x-payment-response",
      "x402-debug-has-payment",
      "x402-debug-payment-len",
      "x402-debug-payment-version"
    ];
    for (const name of debugHeaderNames) {
      const value = response.headers.get(name);
      if (value) {
        next[name] = value;
      }
    }
    if (additional) {
      for (const [key, value] of Object.entries(additional)) {
        next[key] = value;
      }
    }
    return next;
  };

  let paidResponse = await fetch(endpoint, {
    method,
    credentials: "include",
    headers,
    body: requestBody
  });
  let payloadBody = await parseResponseBody(paidResponse);

  let paymentAttemptVersion: number | null = null;
  let paymentAttemptHeader: string | null = null;

  let paymentRequiredHeader: string | null = null;
  let paymentRequiredData: PaymentRequired | null = null;
  let paymentRequiredBody: any | null = null;
  let parsedRequiredForError: PaymentRequired | null = null;

  if (paidResponse.status === 402) {
    const requiredHeader =
      paidResponse.headers.get("payment-required") ||
      paidResponse.headers.get("PAYMENT-REQUIRED");
    if (requiredHeader) {
      paymentRequiredHeader = requiredHeader;
      try {
        const parsedRequired = decodePaymentRequiredHeader(requiredHeader);
        paymentRequiredData = parsedRequired as PaymentRequired;
        parsedRequiredForError = parsedRequired as PaymentRequired;
      } catch {
        paymentRequiredData = null;
      }
    }
    paymentRequiredBody = payloadBody;

    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => paidResponse.headers.get(name),
        payloadBody
      );
      paymentRequiredData = paymentRequired;
      parsedRequiredForError = paymentRequired;
    } catch {
      paymentRequired = paymentRequiredData as PaymentRequired;
    }

    if (!paymentRequired) {
      return {
        status: "error",
        result: payloadBody,
        error: "Failed to parse payment requirements.",
        paymentRequiredData,
        paymentRequiredHeader,
        paymentRequiredBody,
        paymentResponseHeader: null,
        paymentSettleResponse: null,
        paidResponseInfo: {
          status: paidResponse.status,
          body: payloadBody,
          headers: collectDebugHeaders(paidResponse)
        }
      };
    }

    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    paymentAttemptVersion = paymentPayload.x402Version;
    if (paymentPayload.x402Version !== 2) {
      return {
        status: "error",
        result: payloadBody,
        error: `Unsupported payment payload version: ${paymentPayload.x402Version}. Expected v2.`,
        paymentRequiredData,
        paymentRequiredHeader,
        paymentRequiredBody,
        paymentResponseHeader: null,
        paymentSettleResponse: null,
        paidResponseInfo: {
          status: paidResponse.status,
          body: payloadBody,
          headers: collectDebugHeaders(paidResponse, {
            "client-payment-version": String(paymentPayload.x402Version)
          })
        }
      };
    }

    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
    if (!paymentHeaders["PAYMENT-SIGNATURE"]) {
      return {
        status: "error",
        result: payloadBody,
        error: "Failed to create PAYMENT-SIGNATURE header for x402 v2.",
        paymentRequiredData,
        paymentRequiredHeader,
        paymentRequiredBody,
        paymentResponseHeader: null,
        paymentSettleResponse: null,
        paidResponseInfo: {
          status: paidResponse.status,
          body: payloadBody,
          headers: collectDebugHeaders(paidResponse, {
            "client-payment-version": String(paymentPayload.x402Version)
          })
        }
      };
    }
    paymentAttemptHeader = "PAYMENT-SIGNATURE";

    const retryHeaders: Record<string, string> = {
      ...headers,
      ...paymentHeaders,
      "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE"
    };

    paidResponse = await fetch(endpoint, {
      method,
      credentials: "include",
      headers: retryHeaders,
      body: requestBody
    });
    payloadBody = await parseResponseBody(paidResponse);
  }

  const settleHeader =
    paidResponse.headers.get("payment-response") ||
    paidResponse.headers.get("PAYMENT-RESPONSE") ||
    paidResponse.headers.get("x-payment-response") ||
    paidResponse.headers.get("X-PAYMENT-RESPONSE");

  const paidResponseInfo = {
    status: paidResponse.status,
    body: payloadBody,
    headers: collectDebugHeaders(
      paidResponse,
      paymentAttemptVersion
        ? {
            "client-payment-version": String(paymentAttemptVersion),
            "client-payment-header": paymentAttemptHeader ?? "unknown"
          }
        : undefined
    )
  };

  let paymentSettleResponse: any | null = null;
  if (paidResponse.ok) {
    try {
      const paymentResponse = httpClient.getPaymentSettleResponse((name) =>
        paidResponse.headers.get(name)
      );
      if (paymentResponse) {
        paymentSettleResponse = paymentResponse;
      }
    } catch {
      paymentSettleResponse = null;
    }
  }

  if (!paidResponse.ok) {
    if (payloadBody?.error) {
      const details = payloadBody?.details ? `: ${payloadBody.details}` : "";
      return {
        status: "error",
        result: payloadBody,
        error: `${payloadBody.error}${details}`,
        paymentRequiredData,
        paymentRequiredHeader,
        paymentRequiredBody,
        paymentResponseHeader: settleHeader,
        paymentSettleResponse,
        paidResponseInfo
      };
    }
    if (paidResponse.status === 402) {
      return {
        status: "error",
        result: payloadBody,
        error: parsedRequiredForError?.error
          ? `Payment failed: ${parsedRequiredForError.error}`
          : "Payment failed on retry (HTTP 402).",
        paymentRequiredData,
        paymentRequiredHeader,
        paymentRequiredBody,
        paymentResponseHeader: settleHeader,
        paymentSettleResponse,
        paidResponseInfo
      };
    }
    const details = payloadBody?.details ? `: ${payloadBody.details}` : "";
    return {
      status: "error",
      result: payloadBody,
      error: `HTTP ${paidResponse.status}${details}`,
      paymentRequiredData,
      paymentRequiredHeader,
      paymentRequiredBody,
      paymentResponseHeader: settleHeader,
      paymentSettleResponse,
      paidResponseInfo
    };
  }

  return {
    status: "success",
    result: payloadBody,
    error: null,
    paymentRequiredData,
    paymentRequiredHeader,
    paymentRequiredBody,
    paymentResponseHeader: settleHeader,
    paymentSettleResponse,
    paidResponseInfo
  };
}

export function X402Client() {
  const { address, isConnected, chain } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  const [analysisState, setAnalysisState] = useState<PaidState>(emptyPaidState);
  const [analysisLogState, setAnalysisLogState] = useState<AnalysisLogState>(
    emptyAnalysisLogState
  );
  const [bazaarState, setBazaarState] = useState<BazaarState>(emptyBazaarState);
  const [analysisForm, setAnalysisForm] = useState({
    date: "",
    home: "",
    away: ""
  });
  const [bazaarQuery, setBazaarQuery] = useState("nba");
  const [bazaarNetwork, setBazaarNetwork] = useState<string>("eip155:137");
  const [analysisRequestMode, setAnalysisRequestMode] = useState<"paid" | "free">(
    "paid"
  );
  const [autoGameLabel, setAutoGameLabel] = useState<string | null>(null);
  const didAutofillRef = useRef(false);

  const currentChainId = chain?.id ?? null;
  const isOnBaseSepolia = currentChainId === baseSepolia.id;
  const isOnPolygon = currentChainId === polygon.id;
  const isOnSupportedPaidChain =
    typeof currentChainId === "number" &&
    supportedPaidChainIds.has(currentChainId);
  const currentUsdcTokenAddress =
    typeof currentChainId === "number"
      ? usdcTokenByChainId[currentChainId as keyof typeof usdcTokenByChainId]
      : undefined;
  const { data: usdcBalanceRaw, isLoading: isUsdcLoading, error: usdcError } =
    useReadContract({
      abi: erc20Abi,
      address: (currentUsdcTokenAddress ?? zeroAddress) as HexAddress,
      functionName: "balanceOf",
      args: [(address ?? zeroAddress) as HexAddress],
      chainId: currentChainId ?? baseSepolia.id,
      query: {
        enabled: Boolean(address && currentUsdcTokenAddress && currentChainId)
      }
    });
  const usdcBalance =
    typeof usdcBalanceRaw === "bigint"
      ? formatUnits(usdcBalanceRaw, usdcDecimals)
      : null;

  const buildPayDisabledReason = (status: PaidStatus) => {
    if (!isConnected) {
      return "Connect MetaMask first.";
    }
    if (!isOnSupportedPaidChain) {
      return "Switch to Base Sepolia or Polygon first.";
    }
    if (status === "loading") {
      return "Request in progress.";
    }
    return "";
  };

  const handlePaidRequest = async (
    params: Omit<PaidRequestParams, "walletClient" | "address">,
    setState: Dispatch<SetStateAction<PaidState>>
  ): Promise<PaidState> => {
    setState({ ...emptyPaidState, status: "loading" });
    try {
      const nextState = await performPaidRequest({
        ...params,
        walletClient,
        address,
        chainId: chain?.id ?? null
      });
      setState(nextState);
      return nextState;
    } catch (err) {
      const failedState: PaidState = {
        ...emptyPaidState,
        status: "error",
        error: err instanceof Error ? err.message : "Request failed"
      };
      setState(failedState);
      return failedState;
    }
  };

  const loadAnalysisLog = useCallback(async () => {
    if (!isConnected || !address) {
      setAnalysisLogState(emptyAnalysisLogState);
      return;
    }

    setAnalysisLogState((prev) => ({
      ...prev,
      status: "loading",
      error: null
    }));

    const query = new URLSearchParams({
      payerAddress: address,
      page: "1",
      pageSize: "20"
    });

    try {
      const response = await fetch(`${analysisLogEndpoint}?${query.toString()}`, {
        headers: { Accept: "application/json" },
        credentials: "include"
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const details =
          payload && typeof payload.message === "string"
            ? payload.message
            : `HTTP ${response.status}`;
        throw new Error(details);
      }

      const data = Array.isArray(payload?.data)
        ? (payload.data as AnalysisLogItem[])
        : [];
      setAnalysisLogState({
        status: "success",
        data,
        page:
          typeof payload?.page === "number" && payload.page > 0
            ? payload.page
            : 1,
        pageSize:
          typeof payload?.pageSize === "number" && payload.pageSize > 0
            ? payload.pageSize
            : 20,
        total:
          typeof payload?.total === "number" && payload.total >= 0
            ? payload.total
            : data.length,
        error: null
      });
    } catch (err) {
      setAnalysisLogState({
        ...emptyAnalysisLogState,
        status: "error",
        error: err instanceof Error ? err.message : "Failed to load history"
      });
    }
  }, [address, isConnected]);

  const handleAnalysisRequest = async () => {
    const payload = buildAnalysisPayload();
    if (!payload) {
      return;
    }
    setAnalysisRequestMode("paid");
    // Temperature/model are server-controlled; do not send from client.
    const paidResult = await handlePaidRequest(
      { endpoint: analysisEndpoint, method: "POST", body: payload },
      setAnalysisState
    );
    if (paidResult.status === "success") {
      await loadAnalysisLog();
    }
  };

  const loadBazaarResources = useCallback(async () => {
    setBazaarState((prev) => ({
      ...prev,
      status: "loading",
      error: null
    }));
    try {
      const params = new URLSearchParams({
        limit: "20",
        offset: "0"
      });
      if (bazaarQuery.trim()) {
        params.set("query", bazaarQuery.trim());
      }
      if (bazaarNetwork.trim()) {
        params.set("network", bazaarNetwork.trim());
      }
      const response = await fetch(`${bazaarResourcesEndpoint}?${params.toString()}`, {
        headers: { Accept: "application/json" },
        credentials: "include"
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload?.upstream?.error ||
          payload?.error ||
          payload?.message ||
          `HTTP ${response.status}`;
        throw new Error(message);
      }
      const items = Array.isArray(payload?.items)
        ? (payload.items as BazaarResourceItem[])
        : [];
      const total =
        typeof payload?.pagination?.total === "number"
          ? payload.pagination.total
          : items.length;
      setBazaarState({
        status: "success",
        items,
        total,
        error: null
      });
    } catch (err) {
      setBazaarState({
        ...emptyBazaarState,
        status: "error",
        error: err instanceof Error ? err.message : "Failed to load Bazaar resources"
      });
    }
  }, [bazaarNetwork, bazaarQuery]);

  const buildAnalysisPayload = () => {
    if (!analysisForm.date.trim()) {
      setAnalysisState({
        ...emptyPaidState,
        status: "error",
        error: "Please enter a date."
      });
      return null;
    }
    if (!analysisForm.home.trim() || !analysisForm.away.trim()) {
      setAnalysisState({
        ...emptyPaidState,
        status: "error",
        error: "Please enter home and away team abbreviations."
      });
      return null;
    }
    return {
      date: analysisForm.date.trim(),
      home: analysisForm.home.trim().toUpperCase(),
      away: analysisForm.away.trim().toUpperCase()
    };
  };

  const handleFreeAnalysisRequest = async () => {
    const payload = buildAnalysisPayload();
    if (!payload) {
      return;
    }
    setAnalysisRequestMode("free");
    setAnalysisState({ ...emptyPaidState, status: "loading" });
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json"
      };
      if (
        typeof chain?.id === "number" &&
        Number.isInteger(chain.id) &&
        chain.id > 0
      ) {
        headers["X-CHAIN-ID"] = String(chain.id);
      }
      const response = await fetch(analysisFreeEndpoint, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(payload)
      });
      const responseText = await response.text();
      let responseBody: any = {};
      if (responseText) {
        try {
          responseBody = JSON.parse(responseText);
        } catch {
          responseBody = { raw: responseText };
        }
      }

      if (!response.ok) {
        const details =
          typeof responseBody?.message === "string"
            ? responseBody.message
            : typeof responseBody?.error === "string"
              ? responseBody.error
              : `HTTP ${response.status}`;
        setAnalysisState({
          ...emptyPaidState,
          status: "error",
          result: responseBody,
          error: details
        });
        return;
      }

      setAnalysisState({
        ...emptyPaidState,
        status: "success",
        result: responseBody,
        paidResponseInfo: {
          status: response.status,
          body: responseBody,
          headers: {}
        }
      });
    } catch (err) {
      setAnalysisState({
        ...emptyPaidState,
        status: "error",
        error: err instanceof Error ? err.message : "Request failed"
      });
    }
  };

  // Auto-fill runs once on mount to avoid spamming /nba/teams and /nba/games while typing.
  useEffect(() => {
    if (didAutofillRef.current) return;
    didAutofillRef.current = true;

    const controller = new AbortController();
    const fetchTodayFirstGame = async () => {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const date = `${yyyy}-${mm}-${dd}`;

      try {
        const [teamsResponse, gamesResponse] = await Promise.all([
          fetch(`${apiBase}/nba/teams`, { signal: controller.signal }),
          fetch(`${apiBase}/nba/games?date=${date}&page=1&pageSize=50`, {
            signal: controller.signal
          })
        ]);
        if (!teamsResponse.ok || !gamesResponse.ok) {
          return;
        }
        const teamsPayload = await teamsResponse.json();
        const gamesPayload = await gamesResponse.json();

        const teamMap = new Map<string, string>();
        if (Array.isArray(teamsPayload)) {
          for (const team of teamsPayload) {
            if (team?.id && team?.abbrev) {
              teamMap.set(team.id, team.abbrev);
            }
          }
        }

        const games = Array.isArray(gamesPayload?.data)
          ? gamesPayload.data
          : [];
        if (games.length === 0) {
          return;
        }
        const sorted = games
          .filter((game: any) => game?.dateTimeUtc)
          .sort(
            (a: any, b: any) =>
              new Date(a.dateTimeUtc).getTime() -
              new Date(b.dateTimeUtc).getTime()
          );
        const first = sorted[0] || games[0];
        const homeAbbrev = teamMap.get(first?.homeTeamId) || "";
        const awayAbbrev = teamMap.get(first?.awayTeamId) || "";
        setAnalysisForm((prev) => {
          // Don't overwrite user input if they started typing.
          if (prev.date || prev.home || prev.away) return prev;
          return {
            ...prev,
            date,
            home: homeAbbrev,
            away: awayAbbrev
          };
        });
        if (homeAbbrev && awayAbbrev) setAutoGameLabel(`${awayAbbrev}@${homeAbbrev}`);
      } catch {
        // ignore
      }
    };

    fetchTodayFirstGame();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    void loadAnalysisLog();
  }, [loadAnalysisLog]);

  useEffect(() => {
    if (typeof currentChainId !== "number") {
      return;
    }
    setBazaarNetwork(`eip155:${currentChainId}`);
  }, [currentChainId]);

  return (
    <div className="x402-body">
      <div className="x402-panel">
        <div className="card-title">Wallet</div>
        {isConnected ? (
          <div className="wallet-info">
            <div>Connected: {address}</div>
            <div>Network: {chain?.name || "Unknown"}</div>
            <div>
              USDC balance:{" "}
              {!isOnSupportedPaidChain
                ? "Switch to Base Sepolia or Polygon"
                : isUsdcLoading
                  ? "Loading..."
                  : usdcError
                    ? "Unavailable"
                    : `${formatTokenAmount(usdcBalance) ?? "0"} USDC`}
            </div>
            {usdcError ? (
              <div className="hint">USDC read failed.</div>
            ) : null}
            <button onClick={() => disconnect()}>Disconnect</button>
          </div>
        ) : (
          <div className="wallet-actions">
            <button
              onClick={() => connectors[0] && connect({ connector: connectors[0] })}
              disabled={isConnecting || connectors.length === 0}
            >
              Connect MetaMask
            </button>
          </div>
        )}
        {isConnected ? (
          <div className="wallet-actions">
            <button
              onClick={() => switchChain({ chainId: baseSepolia.id })}
              disabled={isSwitching || isOnBaseSepolia}
            >
              Switch to Base Sepolia
            </button>
            <button
              onClick={() => switchChain({ chainId: polygon.id })}
              disabled={isSwitching || isOnPolygon}
            >
              Switch to Polygon
            </button>
          </div>
        ) : null}
        {!isConnected ? (
          <div className="hint">
            Please ensure the MetaMask browser extension is installed.
          </div>
        ) : null}
      </div>

      <div className="x402-panel">
        <div className="card-title">Bazaar Discovery</div>
        <div className="hint">Endpoint: {bazaarResourcesEndpoint}</div>
        <div className="form-row">
          <label className="field">
            <span>Query</span>
            <input
              type="text"
              placeholder="nba analysis"
              value={bazaarQuery}
              onChange={(event) => setBazaarQuery(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Network</span>
            <select
              value={bazaarNetwork}
              onChange={(event) => setBazaarNetwork(event.target.value)}
            >
              <option value="">Any</option>
              <option value={`eip155:${baseSepolia.id}`}>Base Sepolia</option>
              <option value={`eip155:${polygon.id}`}>Polygon</option>
            </select>
          </label>
        </div>
        <div className="form-row">
          <button
            className="ghost"
            onClick={() => void loadBazaarResources()}
            disabled={bazaarState.status === "loading"}
          >
            Search Bazaar
          </button>
        </div>
        {bazaarState.status === "loading" ? (
          <div className="hint">Loading Bazaar resources...</div>
        ) : null}
        {bazaarState.status === "error" ? (
          <div className="error">{bazaarState.error}</div>
        ) : null}
        {bazaarState.items.length > 0 ? (
          <div className="log">
            {bazaarState.items.map((item, index) => {
              const firstAccept = item.accepts?.[0];
              return (
                <div className="log-row" key={`${item.resource ?? "resource"}-${index}`}>
                  <div className="log-meta">
                    <div className="pill">
                      {item.type ?? "resource"} / v{item.x402Version ?? "?"}
                    </div>
                    <div className="hint">
                      Updated: {formatUnixSeconds(item.lastUpdated)}
                    </div>
                  </div>
                  <div className="hint">Resource: {item.resource ?? "-"}</div>
                  <div className="hint">
                    Network: {firstAccept?.network ?? "-"} | Amount:{" "}
                    {firstAccept?.amount ?? "-"} | Asset: {firstAccept?.asset ?? "-"}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {bazaarState.status === "success" && bazaarState.items.length === 0 ? (
          <div className="empty">No Bazaar resources found for current filters.</div>
        ) : null}
        {bazaarState.total > 0 ? (
          <div className="hint">Total discovered: {bazaarState.total}</div>
        ) : null}
      </div>

      <div className="x402-panel">
        <div className="card-title">AI Analysis</div>
        <div className="hint">Paid endpoint: {analysisEndpoint}</div>
        <div className="hint">Free endpoint: {analysisFreeEndpoint}</div>
        <label className="field">
          <span>Date (YYYY-MM-DD)</span>
          <input
            type="text"
            placeholder="2026-02-07"
            value={analysisForm.date}
            onChange={(event) =>
              setAnalysisForm((prev) => ({ ...prev, date: event.target.value }))
            }
          />
        </label>
        <div className="form-row">
          <label className="field">
            <span>Home (abbrev)</span>
            <input
              type="text"
              placeholder="SAS"
              value={analysisForm.home}
              onChange={(event) =>
                setAnalysisForm((prev) => ({
                  ...prev,
                  home: event.target.value
                }))
              }
            />
          </label>
          <label className="field">
            <span>Away (abbrev)</span>
            <input
              type="text"
              placeholder="DAL"
              value={analysisForm.away}
              onChange={(event) =>
                setAnalysisForm((prev) => ({
                  ...prev,
                  away: event.target.value
                }))
              }
            />
          </label>
        </div>
        {autoGameLabel ? (
          <div className="hint">Auto-selected today first game: {autoGameLabel}</div>
        ) : null}
        <div className="form-row">
          <button
            onClick={handleAnalysisRequest}
            disabled={
              !isConnected ||
              !isOnSupportedPaidChain ||
              analysisState.status === "loading"
            }
          >
            Call Paid Analysis (auto)
          </button>
          <button
            className="ghost"
            onClick={handleFreeAnalysisRequest}
            disabled={analysisState.status === "loading"}
          >
            Call Free Analysis
          </button>
        </div>
        {buildPayDisabledReason(analysisState.status) ? (
          <div className="hint">
            Paid disabled: {buildPayDisabledReason(analysisState.status)}
          </div>
        ) : null}
        {analysisState.status === "loading" ? (
          <div className="hint">
            {analysisRequestMode === "paid"
              ? "Waiting for wallet signature and payment..."
              : "Requesting free analysis..."}
          </div>
        ) : null}
        {analysisState.paymentRequiredHeader ? (
          <pre>{`PAYMENT-REQUIRED: ${analysisState.paymentRequiredHeader}`}</pre>
        ) : null}
        {analysisState.paymentRequiredData?.accepts?.[0]?.asset ? (
          <div className="hint">
            USDC token address: {analysisState.paymentRequiredData.accepts[0].asset}
          </div>
        ) : null}
        {analysisState.paymentRequiredData ? (
          <pre>{JSON.stringify(analysisState.paymentRequiredData, null, 2)}</pre>
        ) : null}
        {analysisState.paymentRequiredBody ? (
          <pre>{JSON.stringify(analysisState.paymentRequiredBody, null, 2)}</pre>
        ) : null}
        {analysisState.paymentResponseHeader ? (
          <pre>{`PAYMENT-RESPONSE: ${analysisState.paymentResponseHeader}`}</pre>
        ) : null}
        {analysisState.paymentSettleResponse ? (
          <pre>{JSON.stringify(analysisState.paymentSettleResponse, null, 2)}</pre>
        ) : null}
        {analysisState.paidResponseInfo ? (
          <pre>{JSON.stringify(analysisState.paidResponseInfo, null, 2)}</pre>
        ) : null}
        {analysisState.status === "success" ? (
          <pre>{JSON.stringify(analysisState.result, null, 2)}</pre>
        ) : null}
        {analysisState.status === "error" ? (
          <div className="error">{analysisState.error}</div>
        ) : null}
      </div>

      <div className="x402-panel receipt-panel">
        <div className="receipt-head">
          <div className="card-title">Purchase Receipts</div>
          <button
            className="ghost"
            onClick={() => void loadAnalysisLog()}
            disabled={!isConnected || !address || analysisLogState.status === "loading"}
          >
            Refresh
          </button>
        </div>
        <div className="hint">Source: {analysisLogEndpoint}?payerAddress=&lt;wallet&gt;</div>
        {!isConnected || !address ? (
          <div className="hint">
            Connect wallet to view purchased AI analysis receipts.
          </div>
        ) : null}
        {analysisLogState.status === "loading" ? (
          <div className="hint">Loading purchase history...</div>
        ) : null}
        {analysisLogState.status === "error" ? (
          <div className="error">{analysisLogState.error}</div>
        ) : null}
        {isConnected &&
        address &&
        analysisLogState.status !== "loading" &&
        analysisLogState.status !== "error" &&
        analysisLogState.data.length === 0 ? (
          <div className="empty">No purchased analysis records for this wallet yet.</div>
        ) : null}
        {analysisLogState.data.length > 0 ? (
          <div className="receipt-table-wrap">
            <table className="receipt-table">
              <thead>
                <tr>
                  <th>Purchased At</th>
                  <th>Matchup</th>
                  <th>Confidence</th>
                  <th>Tx Hash</th>
                  <th>Chain ID</th>
                  <th>Status</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {analysisLogState.data.map((item) => (
                  <tr key={item.id}>
                    <td>{formatTimestamp(item.createdAt)}</td>
                    <td>{toReceiptMatchup(item)}</td>
                    <td>{formatConfidence(item.response?.confidence)}</td>
                    <td>{formatTxHash(item.txHash)}</td>
                    <td>{item.chainId ?? "-"}</td>
                    <td>{item.error ? "Failed" : "Paid"}</td>
                    <td>{toReceiptSummary(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {analysisLogState.total > 0 ? (
          <div className="hint">
            Showing {analysisLogState.data.length} / {analysisLogState.total} receipts
          </div>
        ) : null}
      </div>
    </div>
  );
}

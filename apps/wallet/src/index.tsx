import {
  IoAlertCircleOutline,
  IoAdd,
  IoArrowBack,
  IoArrowDown,
  IoArrowUp,
  IoCheckmark,
  IoCheckmarkCircleOutline,
  IoChevronForward,
  IoChevronDown,
  IoClose,
  IoCopyOutline,
  IoGlobeOutline,
  IoOptionsOutline,
  IoOpenOutline,
  IoPeopleOutline,
  IoPersonAddOutline,
  IoPricetagOutline,
  IoRefresh,
  IoReceiptOutline,
  IoSearchOutline,
  IoSend,
  IoStar,
  IoTimeOutline,
  IoWarningOutline,
  IoWalletOutline,
} from "react-icons/io5";
import {
  connectEthereumProvider,
  copyToClipboard,
  createCanisterClient,
  dismissTray,
  isJsonObject,
  listBackendCallReservations,
  onAppStateChange,
  onTileViewRequest,
  openAppTile,
  publishAppStateChange,
  querySelf,
  requestBackendCallReservations,
  updateSelf,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from "react";
import "./style.scss";
import {
  filterCatalog,
  parseCustomLedgerPrincipal,
  WALLET_LEDGER_LIMIT,
  type CatalogLedger,
  type CatalogNetwork,
} from "./catalog.ts";
import {
  formatTokenAmount,
  maxTransferAmount,
  parseTokenAmount,
  parseTransferAmount,
} from "./format.ts";
import {
  confirmationPercent,
  confirmationsRemaining,
  depositOutpoint,
  type WalletDepositIssueKind,
} from "./deposit_progress.ts";
import {
  submitEthereumDeposit,
  type EthereumDepositPhase,
} from "./ethereum.ts";
import {
  destinationLabels,
  parseWalletContactDestinations,
  walletDestinationText,
  type WalletContactDestination,
  type WalletContactDestinationsPage,
  type WalletDestination,
} from "./destinations.ts";
import {
  defaultSubaccountWord,
  ethereumPrincipalWord,
  icrcDepositAddress,
  queryPublicNativeDeposit,
  type PublicNativeDeposit,
} from "./native.ts";
import {
  desiredWalletReservationScopes,
  parseWalletReservationScopes,
  reservationActions,
} from "./reservations.ts";
import {
  historyAddressText,
  historyPageRequest,
  historyRecordKey,
  parseHistoryPage,
  parseHistoryStatus,
  parseHistorySyncReport,
  type HistoryCursor,
  type HistoryRecord,
  type HistoryStatus,
} from "./history.ts";
import {
  PRICE_ASSETS,
  USD_PRICE_FRESH_MS,
  USD_PRICE_REFRESH_MS,
  fetchUsdPriceBook,
  formatUsd,
  hasUsdPrices,
  isPriceAsset,
  optionalBrowserStorage,
  parseUsdPriceCache,
  positionUsdValue,
  priceSourceLabel,
  readUsdPriceCache,
  writeUsdPriceCache,
  USD_PRICE_CACHE_KEY,
  type PriceAsset,
  type UsdPriceBook,
  type UsdQuote,
} from "./prices.ts";
import { TokenMark } from "./token_mark.tsx";
import {
  WALLET_PROJECTION_TOPIC,
  walletTileView,
} from "./wallet_projection.ts";
import {
  parseWalletCatalog,
  parseWalletSnapshot,
  parseWalletSnapshotResult,
  type WalletLedger,
  type WalletSnapshot,
} from "./wallet_data.ts";

type WalletTransferReceipt = {
  blockIndex: string;
  secondaryBlockIndex: string | null;
  duplicate: boolean;
  native: boolean;
};

export type WalletSurface = "tile" | "tray";

type WalletSurfaceContextValue = {
  surface: WalletSurface;
  openInTile: (view: string) => Promise<void>;
};

const WalletSurfaceContext = createContext<WalletSurfaceContextValue | null>(
  null,
);
const WalletFallbackViewContext = createContext("assets");

function publishWalletInvalidation(): void {
  void publishAppStateChange(WALLET_PROJECTION_TOPIC, Date.now()).catch(
    () => undefined,
  );
}

function useWalletSurface(): WalletSurfaceContextValue {
  const value = useContext(WalletSurfaceContext);
  if (!value) throw new Error("Wallet surface context is unavailable");
  return value;
}

export function WalletApp({
  surface = "tile",
}: {
  surface?: WalletSurface;
}) {
  useEffect(() => {
    if (surface !== "tray") return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void dismissTray();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [surface]);

  const openInTile = useCallback(
    (view: string) => {
      const opening = openAppTile({
        appId: "wallet",
        tileId: "wallet",
        reuseExisting: true,
        view,
      });
      return opening.then(async () => {
        if (surface === "tray") await dismissTray();
      });
    },
    [surface],
  );

  return (
    <WalletSurfaceContext.Provider value={{ openInTile, surface }}>
      <WalletAppContent surface={surface} />
    </WalletSurfaceContext.Provider>
  );
}

function WalletAppContent({ surface }: { surface: WalletSurface }) {
  const { openInTile } = useWalletSurface();
  const [view, setView] = useState<"assets" | "activity">("assets");
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [catalog, setCatalog] = useState<CatalogLedger[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [customLedgers, setCustomLedgers] = useState<string[]>([]);
  const [customLedgerOpen, setCustomLedgerOpen] = useState(false);
  const [customLedgerInput, setCustomLedgerInput] = useState("");
  const [customLedgerError, setCustomLedgerError] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [destinationLedger, setDestinationLedger] =
    useState<WalletLedger | null>(null);
  const [destinationQuery, setDestinationQuery] = useState("");
  const [destinationPage, setDestinationPage] =
    useState<WalletContactDestinationsPage | null>(null);
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [contactsBusy, setContactsBusy] = useState(false);
  const [destinationNetwork, setDestinationNetwork] =
    useState<CatalogNetwork>("internet_computer");
  const [transferCandidate, setTransferCandidate] =
    useState<WalletContactDestination | null>(null);
  const [transferAmount, setTransferAmount] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferReceipt, setTransferReceipt] =
    useState<WalletTransferReceipt | null>(null);
  const [depositLedgerId, setDepositLedgerId] = useState<string | null>(null);
  const [publicNativeDeposit, setPublicNativeDeposit] =
    useState<PublicNativeDeposit | null>(null);
  const [publicNativeBusy, setPublicNativeBusy] = useState(false);
  const [publicNativeError, setPublicNativeError] = useState<string | null>(null);
  const [depositRefreshBusy, setDepositRefreshBusy] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [historyCursor, setHistoryCursor] = useState<HistoryCursor | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus | null>(null);
  const [historyLedger, setHistoryLedger] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historySyncing, setHistorySyncing] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyWarning, setHistoryWarning] = useState<string | null>(null);
  const [priceBook, setPriceBook] = useState<UsdPriceBook | null>(null);
  const [priceRefreshing, setPriceRefreshing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [requestedTileView, setRequestedTileView] = useState<string | null>(null);
  const [projectionRevision, setProjectionRevision] = useState(0);
  const depositRefreshInFlight = useRef(false);
  const historyRequest = useRef(0);
  const priceRequest = useRef(0);

  const load = useCallback(async () => {
    const [snapshotValue, catalogValue] = await Promise.all([
      querySelf("wallet_snapshot", [null]),
      querySelf("wallet_catalog", [null]),
    ]);
    const nextSnapshot = parseWalletSnapshot(snapshotValue);
    const nextCatalog = parseWalletCatalog(catalogValue);
    setSnapshot(nextSnapshot);
    setCatalog(nextCatalog);
    setSelected(new Set(nextSnapshot.ledgers.map((ledger) => ledger.principal)));
    setCustomLedgers(customLedgerIds(nextSnapshot, nextCatalog));
    setCustomLedgerOpen(false);
    setCustomLedgerInput("");
    setCustomLedgerError(null);
    setSearch("");
    setSetupOpen(!nextSnapshot.configured);
  }, []);

  const reloadSnapshot = useCallback(async () => {
    setSnapshot(parseWalletSnapshot(await querySelf("wallet_snapshot", [null])));
  }, []);

  useEffect(() => {
    void load().catch((reason) => setError(errorMessage(reason)));
  }, [load]);

  useEffect(
    () =>
      surface === "tile"
        ? onTileViewRequest((nextView) => setRequestedTileView(nextView))
        : undefined,
    [surface],
  );

  useEffect(
    () =>
      onAppStateChange(WALLET_PROJECTION_TOPIC, () => {
        void reloadSnapshot().catch((reason) => setError(errorMessage(reason)));
        setProjectionRevision((current) => current + 1);
      }),
    [reloadSnapshot],
  );

  const loadHistory = useCallback(
    async (append: boolean) => {
      const requestId = ++historyRequest.current;
      if (append) setHistoryLoadingMore(true);
      else setHistoryLoading(true);
      setHistoryError(null);
      try {
        const [pageValue, statusValue] = await Promise.all([
          querySelf("wallet_history_page", [
            historyPageRequest(append ? historyCursor : null, historyLedger),
          ]),
          querySelf("wallet_history_status", [null]),
        ]);
        if (requestId !== historyRequest.current) return;
        const page = parseHistoryPage(pageValue);
        setHistoryRecords((current) =>
          append ? mergeHistoryRecords(current, page.records) : page.records,
        );
        setHistoryCursor(page.next);
        setHistoryHasMore(page.hasMore && page.next !== null);
        setHistoryWarning(page.warning);
        setHistoryStatus(parseHistoryStatus(statusValue));
      } catch (reason) {
        if (requestId === historyRequest.current) {
          setHistoryError(errorMessage(reason));
        }
      } finally {
        if (requestId === historyRequest.current) {
          setHistoryLoading(false);
          setHistoryLoadingMore(false);
        }
      }
    },
    [historyCursor, historyLedger],
  );

  useEffect(() => {
    if (view !== "activity" || setupOpen) return;
    void loadHistory(false);
  }, [historyLedger, projectionRevision, setupOpen, view]);

  const syncHistory = useCallback(async () => {
    if (historySyncing) return;
    setHistorySyncing(true);
    setHistoryError(null);
    try {
      const report = parseHistorySyncReport(
        await updateSelf("wallet_history_sync", [null]),
      );
      const failed = report.results.find((result) => result.error);
      if (failed?.error) setHistoryWarning(failed.error);
      await loadHistory(false);
      publishWalletInvalidation();
    } catch (reason) {
      setHistoryError(errorMessage(reason));
    } finally {
      setHistorySyncing(false);
    }
  }, [historySyncing, loadHistory]);

  const chooseView = (next: "assets" | "activity") => {
    setView(next);
    setError(null);
    setDepositLedgerId(null);
    setDestinationLedger(null);
  };

  const update = useCallback(
    async (method: string, args: JsonValue[], key: string) => {
      setBusy(key);
      setError(null);
      try {
        const value = await updateSelf(method, args);
        setSnapshot(parseWalletSnapshotResult(value));
        publishWalletInvalidation();
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const applySelection = async () => {
    if (!snapshot) return;
    if (surface === "tray") {
      setBusy("apply");
      setError(null);
      try {
        await openInTile(walletTileView("setup"));
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(null);
      }
      return;
    }
    const catalogPrincipals = new Set(
      catalog.map((ledger) => ledger.principal),
    );
    const desired = [
      ...catalog
        .filter((ledger) => selected.has(ledger.principal))
        .map((ledger) => ledger.principal),
      ...[...selected].filter((principal) => !catalogPrincipals.has(principal)),
    ];

    setBusy("apply");
    setError(null);
    try {
      const currentScopes = parseWalletReservationScopes(
        await listBackendCallReservations(),
      );
      const desiredSet = new Set(desired);
      const desiredScopes = desiredWalletReservationScopes(catalog, desiredSet);
      const actions = reservationActions(currentScopes, desiredScopes);
      if (actions.length > 64) {
        throw new Error(
          "This selection needs more than 64 access changes. Apply a smaller selection first, then add the remaining ledgers in a second change.",
        );
      }

      const value = await requestBackendCallReservations({
        actions,
        call: { method: "wallet_set_ledgers", args: [desired] },
      });
      const response = requiredObject(value, "backend access response");
      if (typeof response.callError === "string") {
        throw new Error(
          `Access was updated, but Wallet could not save the selection: ${response.callError}`,
        );
      }
      if (response.callResult === undefined) {
        throw new Error("Wallet did not return the updated selection");
      }
      const nextSnapshot = parseWalletSnapshot(response.callResult);
      setSnapshot(nextSnapshot);
      setSelected(new Set(nextSnapshot.ledgers.map((ledger) => ledger.principal)));
      setCustomLedgers(customLedgerIds(nextSnapshot, catalog));
      setCustomLedgerOpen(false);
      setCustomLedgerInput("");
      setCustomLedgerError(null);
      setSetupOpen(false);
      publishWalletInvalidation();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const openSetup = () => {
    if (!snapshot) return;
    setError(null);
    setDepositLedgerId(null);
    setDestinationLedger(null);
    setSelected(new Set(snapshot.ledgers.map((ledger) => ledger.principal)));
    setCustomLedgers(customLedgerIds(snapshot, catalog));
    setCustomLedgerOpen(false);
    setCustomLedgerInput("");
    setCustomLedgerError(null);
    setSearch("");
    setSetupOpen(true);
  };

  const closeSetup = () => {
    if (!snapshot) return;
    setError(null);
    setSelected(new Set(snapshot.ledgers.map((ledger) => ledger.principal)));
    setCustomLedgers(customLedgerIds(snapshot, catalog));
    setCustomLedgerOpen(false);
    setCustomLedgerInput("");
    setCustomLedgerError(null);
    setSearch("");
    setSetupOpen(false);
  };

  const toggleLedger = (principal: string) => {
    if (surface === "tray") {
      void openInTile(walletTileView("setup")).catch((reason) =>
        setError(errorMessage(reason)),
      );
      return;
    }
    if (!selected.has(principal) && selected.size >= WALLET_LEDGER_LIMIT) {
      setError(`Wallet supports up to ${WALLET_LEDGER_LIMIT} selected ledgers`);
      return;
    }
    setError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(principal)) next.delete(principal);
      else next.add(principal);
      return next;
    });
  };

  const openCustomLedger = () => {
    if (surface === "tray") {
      setBusy("custom-ledger");
      setError(null);
      void openInTile(walletTileView("setup"))
        .catch((reason) => setError(errorMessage(reason)))
        .finally(() => setBusy(null));
      return;
    }
    setCustomLedgerInput("");
    setCustomLedgerError(null);
    setCustomLedgerOpen(true);
  };

  const addCustomLedger = () => {
    if (!snapshot) return;
    let principal: string;
    try {
      principal = parseCustomLedgerPrincipal(customLedgerInput);
    } catch (reason) {
      setCustomLedgerError(errorMessage(reason));
      return;
    }
    if (principal === snapshot.owner) {
      setCustomLedgerError("Neutron's own principal cannot be a ledger");
      return;
    }
    if (!selected.has(principal) && selected.size >= WALLET_LEDGER_LIMIT) {
      setCustomLedgerError(
        `Wallet supports up to ${WALLET_LEDGER_LIMIT} selected ledgers`,
      );
      return;
    }
    if (!catalog.some((ledger) => ledger.principal === principal)) {
      setCustomLedgers((current) =>
        current.includes(principal) ? current : [...current, principal],
      );
    }
    setSelected((current) => new Set(current).add(principal));
    setSearch("");
    setCustomLedgerInput("");
    setCustomLedgerError(null);
    setCustomLedgerOpen(false);
  };

  const closeCustomLedger = () => {
    setCustomLedgerInput("");
    setCustomLedgerError(null);
    setCustomLedgerOpen(false);
  };

  const totalErrors = useMemo(
    () =>
      snapshot?.ledgers.filter(
        (ledger) =>
          ledger.metadataError ||
          ledger.balanceError ||
          ledger.nativeAddressError ||
          ledger.nativeRefreshError,
      ).length ?? 0,
    [snapshot],
  );
  const filteredCatalog = useMemo(
    () => filterCatalog(catalog, search),
    [catalog, search],
  );
  const filteredCustomLedgers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return customLedgers;
    return customLedgers.filter((principal) => {
      const ledger = snapshot?.ledgers.find(
        (candidate) => candidate.principal === principal,
      );
      return `${ledger?.name ?? ""} ${ledger?.symbol ?? ""} ${principal}`
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [customLedgers, search, snapshot]);
  const catalogByPrincipal = useMemo(
    () => new Map(catalog.map((ledger) => [ledger.principal, ledger])),
    [catalog],
  );
  const priceAssets = useMemo(() => {
    const selectedAssets = new Set<PriceAsset>();
    for (const ledger of snapshot?.ledgers ?? []) {
      const asset = catalogByPrincipal.get(ledger.principal)?.priceAsset;
      if (asset) selectedAssets.add(asset);
    }
    return PRICE_ASSETS.filter((asset) => selectedAssets.has(asset));
  }, [catalogByPrincipal, snapshot]);
  const priceAssetKey = priceAssets.join(",");
  const portfolio = useMemo(() => {
    let total = 0n;
    let eligible = 0;
    let valued = 0;
    for (const ledger of snapshot?.ledgers ?? []) {
      const asset = catalogByPrincipal.get(ledger.principal)?.priceAsset ?? null;
      if (!asset) continue;
      eligible += 1;
      const quote = priceBook?.quotes[asset] ?? null;
      const value = positionUsdValue(ledger.balance, ledger.decimals, quote);
      if (value === null) continue;
      total += value;
      valued += 1;
    }
    return { eligible, total, valued };
  }, [catalogByPrincipal, priceBook, snapshot]);
  const destinationCatalog = useMemo(
    () =>
      destinationLedger
        ? catalog.find(
            (ledger) => ledger.principal === destinationLedger.principal,
          ) ?? null
        : null,
    [catalog, destinationLedger],
  );
  const depositLedger = useMemo(
    () =>
      depositLedgerId
        ? snapshot?.ledgers.find(
            (ledger) => ledger.principal === depositLedgerId,
          ) ?? null
        : null,
    [depositLedgerId, snapshot],
  );
  const depositCatalog = useMemo(
    () =>
      depositLedger
        ? catalog.find(
            (ledger) => ledger.principal === depositLedger.principal,
          ) ?? null
        : null,
    [catalog, depositLedger],
  );
  const nativeLedgerKey = useMemo(() => {
    if (!snapshot) return "";
    const selected = new Set(
      snapshot.ledgers.map((ledger) => ledger.principal),
    );
    return catalog
      .filter(
        (ledger) => selected.has(ledger.principal) && ledger.nativeRoute,
      )
      .map((ledger) => ledger.principal)
      .join(",");
  }, [catalog, snapshot]);

  const refreshPrices = useCallback(
    async (force: boolean) => {
      const assets = priceAssetKey
        .split(",")
        .filter(isPriceAsset);
      if (assets.length === 0) {
        setPriceBook(null);
        setPriceError(null);
        setPriceRefreshing(false);
        return;
      }
      const requestId = ++priceRequest.current;
      const storage = optionalBrowserStorage(window);
      const cached = storage ? readUsdPriceCache(storage) : null;
      if (
        !force &&
        cached &&
        Date.now() - cached.updatedAt < USD_PRICE_FRESH_MS &&
        hasUsdPrices(cached, assets)
      ) {
        setPriceBook(cached);
        setPriceError(null);
        return;
      }
      setPriceRefreshing(true);
      try {
        const next = await fetchUsdPriceBook(assets);
        if (requestId !== priceRequest.current) return;
        setPriceBook(next);
        const missing = assets.filter((asset) => !next.quotes[asset]);
        setPriceError(
          missing.length > 0
            ? `USD price unavailable for ${missing.join(", ")}`
            : null,
        );
        try {
          if (storage) writeUsdPriceCache(storage, next);
        } catch {
          // Price caching is optional in restricted browser contexts.
        }
      } catch (reason) {
        if (requestId === priceRequest.current) {
          setPriceError(errorMessage(reason));
        }
      } finally {
        if (requestId === priceRequest.current) setPriceRefreshing(false);
      }
    },
    [priceAssetKey],
  );

  useEffect(() => {
    if (!priceAssetKey) return;
    const assets = priceAssetKey.split(",").filter(isPriceAsset);
    void refreshPrices(false);
    const timer = window.setInterval(
      () => void refreshPrices(false),
      USD_PRICE_REFRESH_MS,
    );
    const onStorage = (event: StorageEvent) => {
      if (event.key !== USD_PRICE_CACHE_KEY || !event.newValue) return;
      const next = parseUsdPriceCache(event.newValue);
      if (next && hasUsdPrices(next, assets)) {
        setPriceBook(next);
        setPriceError(null);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [priceAssetKey, refreshPrices]);

  const refreshDeposits = useCallback(async (surfaceError: boolean) => {
    if (depositRefreshInFlight.current) return;
    depositRefreshInFlight.current = true;
    setDepositRefreshBusy(true);
    if (surfaceError) setError(null);
    try {
      const value = await updateSelf("wallet_refresh_deposits", [null]);
      setSnapshot(parseWalletSnapshotResult(value));
      publishWalletInvalidation();
    } catch (reason) {
      if (surfaceError) setError(errorMessage(reason));
    } finally {
      depositRefreshInFlight.current = false;
      setDepositRefreshBusy(false);
    }
  }, []);
  const refreshVisibleDeposits = useCallback(
    () => void refreshDeposits(true),
    [refreshDeposits],
  );

  useEffect(() => {
    if (surface === "tray" || !nativeLedgerKey || setupOpen) return;
    void refreshDeposits(false);
    const timer = window.setInterval(
      () => void refreshDeposits(false),
      10 * 60 * 1_000,
    );
    return () => window.clearInterval(timer);
  }, [nativeLedgerKey, refreshDeposits, setupOpen, surface]);

  useEffect(() => {
    const route = depositCatalog?.nativeRoute;
    if (
      !snapshot ||
      !depositLedger ||
      !route ||
      (route.kind !== "cketh" &&
        route.kind !== "ckerc20" &&
        route.kind !== "cksol")
    ) {
      setPublicNativeDeposit(null);
      setPublicNativeBusy(false);
      setPublicNativeError(null);
      return;
    }
    let current = true;
    setPublicNativeDeposit(null);
    setPublicNativeBusy(true);
    setPublicNativeError(null);
    void queryPublicNativeDeposit({
      ledger: depositLedger.principal,
      owner: snapshot.owner,
      route,
    })
      .then((value) => {
        if (current) setPublicNativeDeposit(value);
      })
      .catch((reason) => {
        if (current) setPublicNativeError(errorMessage(reason));
      })
      .finally(() => {
        if (current) setPublicNativeBusy(false);
      });
    return () => {
      current = false;
    };
  }, [
    depositCatalog?.nativeRoute,
    depositLedger?.principal,
    snapshot?.owner,
  ]);

  const loadDestinations = useCallback(async () => {
    if (!destinationLedger) return;
    setDestinationBusy(true);
    try {
      const value = await querySelf("wallet_contact_destinations", [
        {
          ledger: destinationLedger.principal,
          network: networkVariant(destinationNetwork),
          search_text: destinationQuery.trim(),
          offset: "0",
          limit: "50",
        },
      ]);
      const next = parseWalletContactDestinations(value);
      if (next.ledger === destinationLedger.principal) {
        setDestinationPage(next);
        setError(null);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDestinationBusy(false);
    }
  }, [destinationLedger, destinationNetwork, destinationQuery]);

  useEffect(() => {
    if (!destinationLedger) return;
    const timer = window.setTimeout(() => void loadDestinations(), 180);
    return () => window.clearTimeout(timer);
  }, [destinationLedger, loadDestinations]);

  const openDestinations = (ledger: WalletLedger) => {
    setError(null);
    setDepositLedgerId(null);
    setDestinationQuery("");
    setDestinationPage(null);
    setDestinationNetwork("internet_computer");
    setTransferCandidate(null);
    setTransferAmount("");
    setTransferReceipt(null);
    setDestinationLedger(ledger);
  };

  const openDeposit = (ledger: WalletLedger) => {
    setError(null);
    setDestinationLedger(null);
    setDepositLedgerId(ledger.principal);
    setPublicNativeDeposit(null);
    setPublicNativeError(null);
  };

  const closeDeposit = () => {
    setDepositLedgerId(null);
    setPublicNativeDeposit(null);
    setPublicNativeError(null);
    setError(null);
  };

  const closeDestinations = () => {
    setDestinationLedger(null);
    setDestinationQuery("");
    setDestinationPage(null);
    setDestinationNetwork("internet_computer");
    setTransferCandidate(null);
    setTransferAmount("");
    setTransferReceipt(null);
    setError(null);
  };

  useEffect(() => {
    if (!snapshot || requestedTileView === null) return;
    const requested = requestedTileView;
    setRequestedTileView(null);
    setError(null);

    if (requested === "setup") {
      setDepositLedgerId(null);
      setDestinationLedger(null);
      setSelected(
        new Set(snapshot.ledgers.map((ledger) => ledger.principal)),
      );
      setCustomLedgers(customLedgerIds(snapshot, catalog));
      setCustomLedgerOpen(false);
      setCustomLedgerInput("");
      setCustomLedgerError(null);
      setSearch("");
      setSetupOpen(true);
      return;
    }

    if (requested === "activity") {
      setSetupOpen(false);
      setDepositLedgerId(null);
      setDestinationLedger(null);
      setView("activity");
      return;
    }

    const assetRequest = /^(receive|deposit|send)\/(0|[1-9][0-9]{0,39})$/.exec(
      requested,
    );
    const ledger = assetRequest
      ? snapshot.ledgers.find((candidate) => candidate.id === assetRequest[2])
      : null;

    setSetupOpen(false);
    setView("assets");
    if (!assetRequest || !ledger) {
      setDepositLedgerId(null);
      setDestinationLedger(null);
      return;
    }

    if (assetRequest[1] === "receive" || assetRequest[1] === "deposit") {
      setDestinationLedger(null);
      setDepositLedgerId(ledger.principal);
      setPublicNativeDeposit(null);
      setPublicNativeError(null);
      return;
    }

    setDepositLedgerId(null);
    setDestinationQuery("");
    setDestinationPage(null);
    setDestinationNetwork("internet_computer");
    setTransferCandidate(null);
    setTransferAmount("");
    setTransferReceipt(null);
    setDestinationLedger(ledger);
  }, [catalog, requestedTileView, snapshot]);

  const chooseDestinationNetwork = (network: CatalogNetwork) => {
    setDestinationNetwork(network);
    setDestinationPage(null);
    setTransferCandidate(null);
    setTransferAmount("");
    setTransferReceipt(null);
  };

  const chooseTransferDestination = (candidate: WalletContactDestination) => {
    setError(null);
    setTransferCandidate(candidate);
    setTransferAmount("");
    setTransferReceipt(null);
  };

  const openContacts = async () => {
    setContactsBusy(true);
    setError(null);
    try {
      await openAppTile({
        appId: "contacts",
        tileId: "contacts",
        reuseExisting: true,
        view: "create",
      });
      if (surface === "tray") await dismissTray();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setContactsBusy(false);
    }
  };

  const cancelTransfer = () => {
    setTransferCandidate(null);
    setTransferAmount("");
    setTransferReceipt(null);
    setError(null);
  };

  const submitTransfer = async () => {
    if (!snapshot || !destinationLedger || !transferCandidate) return;
    let amount: string;
    try {
      amount = parseTransferAmount(transferAmount, destinationLedger);
    } catch (reason) {
      setError(errorMessage(reason));
      return;
    }

    setTransferBusy(true);
    setError(null);
    try {
      const value = await createCanisterClient(snapshot.owner).callDialog(
        "wallet_transfer",
        [
          {
            ledger: destinationLedger.principal,
            network: networkVariant(destinationNetwork),
            contact_id: transferCandidate.contactId,
            contact_revision: transferCandidate.contactRevision,
            address_id: transferCandidate.addressId,
            expected_destination: destinationVariant(
              transferCandidate.destination,
            ),
            amount,
          },
        ],
        60,
      );
      setTransferReceipt(asTransferReceipt(value));
      try {
        const refreshed = await updateSelf("wallet_refresh_balances", [null]);
        setSnapshot(parseWalletSnapshotResult(refreshed));
      } catch (reason) {
        setError(`Transfer recorded; balance refresh failed: ${errorMessage(reason)}`);
      }
      publishWalletInvalidation();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setTransferBusy(false);
    }
  };

  if (!snapshot) {
    return (
      <main
        className={`nt-app wallet-app wallet-app--${surface} wallet-loading`}
        aria-label="Loading Wallet"
      >
        <span className="wallet-spinner" />
      </main>
    );
  }

  if (setupOpen) {
    return (
      <main className={`nt-app wallet-app wallet-app--${surface}`}>
        <div className="wallet-shell wallet-setup-shell">
          <div className="wallet-setup-body">
            {error ? <WalletNotice message={error} /> : null}

            <section
              className="wallet-catalog-window"
              aria-label="Available token ledgers"
            >
              <div className="wallet-search">
                <label className="wallet-search-field">
                  <IoSearchOutline aria-hidden="true" />
                  <input
                    aria-label="Find token ledger"
                    autoComplete="off"
                    className="nt-input"
                    disabled={busy !== null}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Find by name, symbol, or canister id"
                    spellCheck={false}
                    type="search"
                    value={search}
                  />
                </label>
                <span className="wallet-search-count" aria-live="polite">
                  {filteredCatalog.length + filteredCustomLedgers.length}/
                  {catalog.length + customLedgers.length}
                </span>
              </div>

              <div className="wallet-catalog">
                {filteredCatalog.length + filteredCustomLedgers.length === 0 ? (
                  <div className="wallet-catalog-empty">No matching ledgers</div>
                ) : (
                  <>
                    {filteredCatalog.map((ledger) => {
                      const checked = selected.has(ledger.principal);
                      return (
                        <label
                          className="wallet-catalog-row"
                          key={ledger.principal}
                        >
                          <TokenMark
                            logo={
                              snapshot.ledgers.find(
                                (candidate) =>
                                  candidate.principal === ledger.principal,
                              )?.logo ?? null
                            }
                            symbol={ledger.symbol}
                          />
                          <span className="wallet-token-identity">
                            <strong>{ledger.name}</strong>
                            <small title={ledger.principal}>
                              {ledger.symbol} /{" "}
                              {compactPrincipal(ledger.principal)}
                            </small>
                          </span>
                          <input
                            checked={checked}
                            disabled={
                              busy !== null ||
                              surface === "tray" ||
                              (!checked && selected.size >= WALLET_LEDGER_LIMIT)
                            }
                            onChange={() => toggleLedger(ledger.principal)}
                            type="checkbox"
                          />
                          <span className="wallet-switch" aria-hidden="true" />
                        </label>
                      );
                    })}
                    {filteredCustomLedgers.map((principal) => {
                      const checked = selected.has(principal);
                      const ledger = snapshot.ledgers.find(
                        (candidate) => candidate.principal === principal,
                      );
                      return (
                        <label
                          className="wallet-catalog-row wallet-catalog-row--custom"
                          key={principal}
                        >
                          <TokenMark
                            logo={ledger?.logo ?? null}
                            symbol={ledger?.symbol ?? null}
                          />
                          <span className="wallet-token-identity">
                            <strong>
                              {ledger?.name ?? ledger?.symbol ?? "Custom ledger"}
                            </strong>
                            <small title={principal}>
                              {ledger?.symbol
                                ? `${ledger.symbol} / `
                                : "Custom / "}
                              {compactPrincipal(principal)}
                            </small>
                          </span>
                          <input
                            checked={checked}
                            disabled={
                              busy !== null ||
                              surface === "tray" ||
                              (!checked && selected.size >= WALLET_LEDGER_LIMIT)
                            }
                            onChange={() => toggleLedger(principal)}
                            type="checkbox"
                          />
                          <span className="wallet-switch" aria-hidden="true" />
                        </label>
                      );
                    })}
                  </>
                )}
              </div>

              <div className="wallet-custom-ledger">
                {customLedgerOpen && surface !== "tray" ? (
                  <div
                    aria-label="Add custom ledger"
                    className="wallet-custom-ledger-entry"
                    role="group"
                  >
                    <div className="wallet-custom-ledger-controls">
                      <input
                        aria-describedby={
                          customLedgerError
                            ? "wallet-custom-ledger-error"
                            : undefined
                        }
                        aria-invalid={customLedgerError !== null}
                        aria-label="Custom ledger canister ID"
                        autoComplete="off"
                        autoFocus
                        className="nt-input"
                        disabled={busy !== null}
                        onChange={(event) => {
                          setCustomLedgerInput(event.target.value);
                          setCustomLedgerError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          if (!event.nativeEvent.isComposing) {
                            addCustomLedger();
                          }
                        }}
                        placeholder="Ledger canister principal"
                        spellCheck={false}
                        value={customLedgerInput}
                      />
                      <button
                        aria-label="Cancel adding custom ledger"
                        className="nt-icon-button"
                        disabled={busy !== null}
                        onClick={closeCustomLedger}
                        type="button"
                      >
                        <IoClose aria-hidden="true" />
                      </button>
                      <button
                        className="nt-button nt-button--sm"
                        disabled={busy !== null}
                        onClick={addCustomLedger}
                        type="button"
                      >
                        <IoAdd aria-hidden="true" />
                        Add
                      </button>
                    </div>
                    {customLedgerError ? (
                      <small id="wallet-custom-ledger-error" role="alert">
                        {customLedgerError}
                      </small>
                    ) : null}
                  </div>
                ) : (
                  <button
                    className="wallet-custom-ledger-button"
                    disabled={
                      busy !== null ||
                      (surface !== "tray" &&
                        selected.size >= WALLET_LEDGER_LIMIT)
                    }
                    onClick={openCustomLedger}
                    type="button"
                  >
                    {surface === "tray" ? (
                      <IoOpenOutline aria-hidden="true" />
                    ) : (
                      <IoAdd aria-hidden="true" />
                    )}
                    {surface === "tray"
                      ? "Add custom ledger in Wallet"
                      : "Add custom ledger"}
                  </button>
                )}
              </div>
            </section>
          </div>

          <footer className="wallet-setup-actions">
            <span className="wallet-selection-count">
              <strong>
                {selected.size}/{WALLET_LEDGER_LIMIT}
              </strong>{" "}
              selected
            </span>
            <button
              className="nt-button nt-button--secondary nt-button--sm"
              disabled={busy !== null}
              onClick={closeSetup}
              type="button"
            >
              <IoClose aria-hidden="true" />
              Cancel
            </button>
            <button
              className="nt-button nt-button--sm wallet-apply-button"
              disabled={
                busy !== null
              }
              onClick={() => void applySelection()}
              type="button"
            >
              {busy === "apply" ? (
                <span className="wallet-spinner" />
              ) : surface === "tray" ? (
                <IoOpenOutline aria-hidden="true" />
              ) : (
                <IoCheckmark aria-hidden="true" />
              )}
              {surface === "tray" ? "Open Wallet" : "Apply"}
            </button>
          </footer>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`nt-app wallet-app wallet-app--${surface}${
        depositLedger || destinationLedger ? " wallet-app--subview" : ""
      }`}
    >
      <div className="wallet-shell">
        <header className="wallet-toolbar">
          <div className="wallet-view-switch" role="tablist" aria-label="Wallet view">
            <button
              aria-label="Assets"
              aria-selected={view === "assets"}
              className={view === "assets" ? "is-active" : undefined}
              onClick={() => chooseView("assets")}
              role="tab"
              type="button"
            >
              <IoWalletOutline aria-hidden="true" />
              <span>Assets</span>
            </button>
            <button
              aria-label="Activity"
              aria-selected={view === "activity"}
              className={view === "activity" ? "is-active" : undefined}
              onClick={() => chooseView("activity")}
              role="tab"
              type="button"
            >
              <IoReceiptOutline aria-hidden="true" />
              <span>Activity</span>
            </button>
          </div>
          <span className="wallet-toolbar-spacer" />
          {view === "assets" && portfolio.eligible > 0 ? (
            <PortfolioValue
              book={priceBook}
              eligible={portfolio.eligible}
              error={priceError}
              loading={priceRefreshing}
              total={portfolio.total}
              valued={portfolio.valued}
            />
          ) : null}
          {totalErrors > 0 ? (
            <span
              className="wallet-error-count"
              title={`${totalErrors} token refresh error${totalErrors === 1 ? "" : "s"}`}
            >
              <IoAlertCircleOutline aria-hidden="true" />
              {totalErrors}
            </span>
          ) : null}
          <IconButton
            className="wallet-setup-trigger"
            label="Choose token ledgers"
            disabled={busy !== null || view !== "assets"}
            onClick={openSetup}
          >
            <IoOptionsOutline />
          </IconButton>
          <IconButton
            className="wallet-metadata-trigger"
            label="Refresh token metadata"
            disabled={
              busy !== null || snapshot.ledgers.length === 0 || view !== "assets"
            }
            active={busy === "metadata"}
            onClick={() =>
              void update("wallet_refresh_metadata", [null], "metadata")
            }
          >
            <IoPricetagOutline />
          </IconButton>
          <IconButton
            className="wallet-refresh-trigger"
            label={view === "activity" ? "Sync activity" : "Refresh balances"}
            disabled={
              busy !== null ||
              snapshot.ledgers.length === 0 ||
              historySyncing
            }
            active={view === "activity" ? historySyncing : busy === "balances"}
            onClick={() => {
              if (view === "activity") void syncHistory();
              else {
                void update("wallet_refresh_balances", [null], "balances");
                void refreshPrices(true);
              }
            }}
          >
            <IoRefresh />
          </IconButton>
        </header>

        {error ? <WalletNotice message={error} /> : null}

        {view === "activity" ? (
          <WalletActivity
            catalog={catalog}
            hasMore={historyHasMore}
            ledger={historyLedger}
            ledgers={snapshot.ledgers}
            loading={historyLoading}
            loadingMore={historyLoadingMore}
            onLedger={setHistoryLedger}
            onLoadMore={() => void loadHistory(true)}
            records={historyRecords}
            status={historyStatus}
            warning={historyError ?? historyWarning}
          />
        ) : depositLedger ? (
          <WalletDeposit
            catalog={depositCatalog}
            ledger={depositLedger}
            onBack={closeDeposit}
            onRefresh={refreshVisibleDeposits}
            owner={snapshot.owner}
            publicNative={publicNativeDeposit}
            publicNativeBusy={publicNativeBusy}
            publicNativeError={publicNativeError}
            refreshBusy={depositRefreshBusy}
          />
        ) : destinationLedger ? (
          <WalletDestinations
            busy={destinationBusy}
            catalog={destinationCatalog}
            contactsBusy={contactsBusy}
            ledger={destinationLedger}
            network={destinationNetwork}
            onBack={closeDestinations}
            onCancelTransfer={cancelTransfer}
            onContacts={() => void openContacts()}
            onNetwork={chooseDestinationNetwork}
            onQuery={setDestinationQuery}
            onRefresh={() => void loadDestinations()}
            onSelect={chooseTransferDestination}
            onSubmit={() => void submitTransfer()}
            page={destinationPage}
            query={destinationQuery}
            transferAmount={transferAmount}
            transferBusy={transferBusy}
            transferCandidate={transferCandidate}
            transferReceipt={transferReceipt}
            onTransferAmount={setTransferAmount}
          />
        ) : (
          <section className="wallet-ledgers" aria-label="Tokens">
            {snapshot.ledgers.length === 0 ? (
              <div className="wallet-empty">
                <IoWalletOutline aria-hidden="true" />
                <span>No ledgers selected</span>
              </div>
            ) : (
              snapshot.ledgers.map((ledger) => {
                const priceAsset =
                  catalogByPrincipal.get(ledger.principal)?.priceAsset ?? null;
                return (
                  <TokenRow
                    custom={!catalogByPrincipal.has(ledger.principal)}
                    key={ledger.id}
                    ledger={ledger}
                    onDeposit={() => openDeposit(ledger)}
                    onContacts={() => openDestinations(ledger)}
                    priceAsset={priceAsset}
                    quote={priceAsset ? priceBook?.quotes[priceAsset] ?? null : null}
                  />
                );
              })
            )}
          </section>
        )}
        {surface === "tile" ? (
          <aside
            aria-label="Wallet alpha warning"
            className="wallet-alpha-notice"
            role="note"
          >
            <IoWarningOutline aria-hidden="true" />
            <span>
              Alpha - not battle tested, don't put more tokens than you can
              afford to lose
            </span>
          </aside>
        ) : null}
      </div>
    </main>
  );
}

function WalletNotice({ message }: { message: string }) {
  return (
    <div className="wallet-notice" role="alert">
      <IoAlertCircleOutline aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function PortfolioValue({
  book,
  eligible,
  error,
  loading,
  total,
  valued,
}: {
  book: UsdPriceBook | null;
  eligible: number;
  error: string | null;
  loading: boolean;
  total: bigint;
  valued: number;
}) {
  const stale =
    book !== null && Date.now() - book.updatedAt > USD_PRICE_REFRESH_MS * 2;
  const incomplete = valued < eligible;
  const issue = error ?? (stale ? "USD prices are stale" : null);
  const providers =
    book?.providers.map(priceSourceLabel).join(" + ") ?? "public market APIs";
  const updated = book
    ? new Date(book.updatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const title = [
    `Estimated from ${providers}`,
    updated ? `updated ${updated}` : null,
    incomplete ? `${valued} of ${eligible} assets valued` : null,
    issue,
  ]
    .filter(Boolean)
    .join(" / ");
  return (
    <span
      aria-label={valued > 0 ? `Portfolio value ${formatUsd(total)}` : "Portfolio value unavailable"}
      className={`wallet-portfolio${issue || incomplete ? " is-warning" : ""}`}
      role="status"
      title={title}
    >
      <strong>{valued > 0 ? formatUsd(total) : "-"}</strong>
      <small>{loading && !book ? <span className="wallet-spinner" /> : "USD"}</small>
      {issue || incomplete ? <IoWarningOutline aria-hidden="true" /> : null}
    </span>
  );
}

function TokenRow({
  custom,
  ledger,
  onDeposit,
  onContacts,
  priceAsset,
  quote,
}: {
  custom: boolean;
  ledger: WalletLedger;
  onDeposit: () => void;
  onContacts: () => void;
  priceAsset: PriceAsset | null;
  quote: UsdQuote | null;
}) {
  const symbol = ledger.symbol ?? "?";
  const displayBalance =
    ledger.balance === null || ledger.decimals === null
      ? "-"
      : formatTokenAmount(ledger.balance, ledger.decimals);
  const rowError =
    ledger.nativeAddressError ??
    ledger.nativeRefreshError ??
    ledger.balanceError ??
    ledger.metadataError;
  const usdValue = positionUsdValue(ledger.balance, ledger.decimals, quote);
  const details = [
    ledger.fee && ledger.decimals !== null
      ? `Fee ${formatTokenAmount(ledger.fee, ledger.decimals)}`
      : null,
    priceAsset && quote
      ? `1 ${priceAsset} = ${formatUsd(quote.usd)} via ${priceSourceLabel(quote.source)}`
      : null,
  ]
    .filter(Boolean)
    .join(" / ");
  return (
    <article className="wallet-token" data-ledger={ledger.principal}>
      <TokenMark logo={ledger.logo} symbol={symbol} />
      <span className="wallet-token-identity">
        <strong>{ledger.name ?? ledger.symbol ?? "Unknown token"}</strong>
        <small title={ledger.principal}>
          {custom ? "Custom / " : ""}
          {ledger.symbol ? `${ledger.symbol} / ` : ""}
          {compactPrincipal(ledger.principal)}
        </small>
      </span>
      <span
        className="wallet-token-balance"
        title={
          [
            `${displayBalance} ${ledger.symbol ?? "units"}`,
            details || null,
          ]
            .filter(Boolean)
            .join(" / ")
        }
      >
        <strong>{displayBalance}</strong>
        <small className={usdValue === null ? undefined : "wallet-token-usd"}>
          {usdValue !== null
            ? formatUsd(usdValue)
            : priceAsset
              ? "- USD"
              : ledger.symbol ?? "units"}
        </small>
      </span>
      {rowError ? (
        <span className="wallet-token-error" title={rowError}>
          <IoAlertCircleOutline aria-hidden="true" />
        </span>
      ) : (
        <span />
      )}
      <span className="wallet-token-actions">
        <IconButton
          label={`Deposit ${ledger.symbol ?? ledger.name ?? "token"}`}
          onClick={onDeposit}
        >
          <IoAdd />
        </IconButton>
        <IconButton
          label={`Send ${ledger.symbol ?? ledger.name ?? "token"}`}
          onClick={onContacts}
        >
          <IoSend />
        </IconButton>
      </span>
    </article>
  );
}

function WalletActivity({
  catalog,
  hasMore,
  ledger,
  ledgers,
  loading,
  loadingMore,
  onLedger,
  onLoadMore,
  records,
  status,
  warning,
}: {
  catalog: CatalogLedger[];
  hasMore: boolean;
  ledger: string | null;
  ledgers: WalletLedger[];
  loading: boolean;
  loadingMore: boolean;
  onLedger: (ledger: string | null) => void;
  onLoadMore: () => void;
  records: HistoryRecord[];
  status: HistoryStatus | null;
  warning: string | null;
}) {
  const [direction, setDirection] = useState<
    "all" | "incoming" | "outgoing" | "adjustments"
  >("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const reviewedLedgers = new Set(catalog.map((item) => item.principal));
  const available = new Set([
    ...ledgers.map((item) => item.principal),
    ...(status?.ledgers.map((item) => item.ledger) ?? []),
  ]);
  const ledgerOptions: Array<{ principal: string; symbol: string }> = catalog
    .filter((item) => available.has(item.principal))
    .map((item) => ({ principal: item.principal, symbol: item.symbol }));
  const included = new Set(ledgerOptions.map((item) => item.principal));
  for (const item of ledgers) {
    if (included.has(item.principal)) continue;
    ledgerOptions.push({
      principal: item.principal,
      symbol: item.symbol ?? item.name ?? compactPrincipal(item.principal),
    });
    included.add(item.principal);
  }
  for (const item of status?.ledgers ?? []) {
    if (included.has(item.ledger)) continue;
    ledgerOptions.push({
      principal: item.ledger,
      symbol: item.symbol ?? compactPrincipal(item.ledger),
    });
    included.add(item.ledger);
  }
  const visible = records.filter((record) => {
    if (direction === "adjustments") return record.kind === "adjustment";
    if (direction === "incoming") return BigInt(record.balanceEffect) > 0n;
    if (direction === "outgoing") return BigInt(record.balanceEffect) < 0n;
    return true;
  });
  const groups = groupHistoryByDay(visible);
  const activeState = status?.ledgers.find(
    (item) => item.enabled && item.state !== "idle",
  );
  const statusMessage = warning ?? activeState?.lastError ?? null;

  return (
    <section className="wallet-activity" aria-label="Wallet activity">
      <div className="wallet-activity-filters">
        <label>
          <span className="nt-sr-only">Token</span>
          <select
            aria-label="Filter activity by token"
            className="nt-select"
            onChange={(event) => onLedger(event.target.value || null)}
            value={ledger ?? ""}
          >
            <option value="">All tokens</option>
            {ledgerOptions.map((item) => (
              <option key={item.principal} value={item.principal}>
                {item.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="nt-sr-only">Direction</span>
          <select
            aria-label="Filter activity by direction"
            className="nt-select"
            onChange={(event) =>
              setDirection(
                event.target.value as
                  | "all"
                  | "incoming"
                  | "outgoing"
                  | "adjustments",
              )
            }
            value={direction}
          >
            <option value="all">All activity</option>
            <option value="incoming">Incoming</option>
            <option value="outgoing">Outgoing</option>
            <option value="adjustments">Adjustments</option>
          </select>
        </label>
        <span className="wallet-activity-count">
          {visible.length}
        </span>
      </div>

      {statusMessage || activeState ? (
        <div
          className={`wallet-activity-state${statusMessage ? " is-warning" : ""}`}
          role={statusMessage ? "alert" : "status"}
        >
          {statusMessage ? (
            <IoWarningOutline aria-hidden="true" />
          ) : (
            <span className="wallet-spinner" />
          )}
          <span>
            {statusMessage ?? historyStateLabel(activeState?.state ?? "idle")}
          </span>
        </div>
      ) : null}

      <div className="wallet-activity-list">
        {loading ? (
          <div className="wallet-loading" aria-label="Loading activity">
            <span className="wallet-spinner" />
          </div>
        ) : groups.length === 0 ? (
          <div className="wallet-empty">
            <IoReceiptOutline aria-hidden="true" />
            <span>No activity yet</span>
          </div>
        ) : (
          groups.map((group) => (
            <section className="wallet-activity-day" key={group.key}>
              <h2>{group.label}</h2>
              {group.records.map((record) => {
                const key = historyRecordKey(record);
                const isOpen = expanded === key;
                const customLedger = !reviewedLedgers.has(record.ledger);
                const verificationMessage =
                  record.kind === "transaction" &&
                  record.verification !== "verified"
                    ? verificationLabel(record.verification, customLedger)
                    : undefined;
                return (
                  <article
                    className={`wallet-activity-entry${
                      record.kind === "adjustment" ? " is-adjustment" : ""
                    }`}
                    key={key}
                  >
                    <button
                      aria-expanded={isOpen}
                      className="wallet-activity-row"
                      onClick={() => setExpanded(isOpen ? null : key)}
                      type="button"
                    >
                      <span className={`wallet-activity-operation ${historyDirection(record)}`}>
                        {historyIcon(record)}
                      </span>
                      <TokenMark
                        logo={record.logo}
                        symbol={record.symbol ?? "?"}
                      />
                      <span className="wallet-activity-main">
                        <strong>{historyLabel(record)}</strong>
                        <small title={historyCounterparty(record)}>
                          {compactHistoryText(historyCounterparty(record))}
                        </small>
                      </span>
                      <span className="wallet-activity-value">
                        <strong className={historyDirection(record)}>
                          {historyAmount(record)}
                        </strong>
                        <small>
                          {record.symbol ?? "units"} / {historyTime(record.timestampNs)}
                        </small>
                      </span>
                      <span
                        aria-label={verificationMessage}
                        aria-hidden={
                          record.kind !== "transaction" ||
                          record.verification === "verified"
                        }
                        className={`wallet-activity-pending${
                          record.kind !== "transaction" ||
                          record.verification === "verified"
                            ? " is-hidden"
                            : ""
                        }`}
                        title={verificationMessage}
                      />
                      <IoChevronDown
                        aria-hidden="true"
                        className={`wallet-activity-chevron${isOpen ? " is-open" : ""}`}
                      />
                    </button>
                    {isOpen ? (
                      <HistoryDetails
                        customLedger={customLedger}
                        record={record}
                      />
                    ) : null}
                  </article>
                );
              })}
            </section>
          ))
        )}
        {hasMore && !loading ? (
          <button
            className="wallet-activity-more"
            disabled={loadingMore}
            onClick={onLoadMore}
            type="button"
          >
            {loadingMore ? <span className="wallet-spinner" /> : "Load more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function HistoryDetails({
  customLedger,
  record,
}: {
  customLedger: boolean;
  record: HistoryRecord;
}) {
  if (record.kind === "adjustment") {
    return (
      <dl className="wallet-history-details">
        <HistoryDetail label="Ledger" value={record.ledger} code />
        <HistoryDetail label="Reason" value={adjustmentLabel(record.adjustmentKind)} />
        <HistoryDetail label="Previous" value={record.previousBalance} code />
        <HistoryDetail label="Observed" value={record.observedBalance} code />
        <HistoryDetail
          label="Scan"
          value={`${record.fromTipExclusive} to ${record.toTipExclusive}`}
          code
        />
        <HistoryDetail label="Detail" value={record.detail} />
      </dl>
    );
  }
  return (
    <dl className="wallet-history-details">
      <HistoryDetail label="Ledger" value={record.ledger} code />
      <HistoryDetail label="Block" value={record.blockIndex} code />
      <HistoryDetail label="From" value={historyAddressText(record.from) ?? "-"} code />
      <HistoryDetail label="To" value={historyAddressText(record.to) ?? "-"} code />
      {record.spender ? (
        <HistoryDetail label="Spender" value={historyAddressText(record.spender) ?? "-"} code />
      ) : null}
      <HistoryDetail
        label="Fee"
        value={
          record.fee === null
            ? "-"
            : `${formatTokenAmount(record.fee, record.decimals)} ${record.symbol ?? "units"}`
        }
      />
      {record.intent ? (
        <HistoryDetail
          label="Destination"
          value={`${record.intent.contactName} / ${record.intent.destination}`}
        />
      ) : null}
      {record.memo ? <HistoryDetail label="Memo" value={record.memo} code /> : null}
      {record.native?.transactionId ? (
        <HistoryDetail label="Native transaction" value={record.native.transactionId} code />
      ) : null}
      {record.native?.relatedBlockIndex ? (
        <HistoryDetail
          label="Related burn"
          value={`${record.native.relatedLedger ?? "ledger"} / ${record.native.relatedBlockIndex}`}
          code
        />
      ) : null}
      <HistoryDetail
        label="Source"
        value={
          customLedger &&
          record.provenance === "local_pending" &&
          record.verification === "pending"
            ? "Local receipt / pending ledger scan"
            : `${record.provenance} / ${record.verification}`
        }
      />
    </dl>
  );
}

function HistoryDetail({
  code = false,
  label,
  value,
}: {
  code?: boolean;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  );
}

function mergeHistoryRecords(
  current: HistoryRecord[],
  next: HistoryRecord[],
): HistoryRecord[] {
  const merged = new Map(current.map((record) => [historyRecordKey(record), record]));
  for (const record of next) merged.set(historyRecordKey(record), record);
  return [...merged.values()];
}

function groupHistoryByDay(records: HistoryRecord[]) {
  const groups: Array<{ key: string; label: string; records: HistoryRecord[] }> = [];
  for (const record of records) {
    const date = historyDate(record.timestampNs);
    const key = date ? date.toLocaleDateString("en-CA") : "unknown";
    const last = groups.at(-1);
    if (last?.key === key) last.records.push(record);
    else {
      groups.push({
        key,
        label: date
          ? date.toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
              year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
            })
          : "Unknown date",
        records: [record],
      });
    }
  }
  return groups;
}

function historyDate(timestampNs: string): Date | null {
  const milliseconds = BigInt(timestampNs) / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const date = new Date(Number(milliseconds));
  return Number.isNaN(date.getTime()) ? null : date;
}

function historyTime(timestampNs: string): string {
  const date = historyDate(timestampNs);
  return date
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "-";
}

function historyLabel(record: HistoryRecord): string {
  if (record.kind === "adjustment") {
    return record.adjustmentKind === "opening_balance"
      ? "Opening balance"
      : "Balance adjustment";
  }
  if (record.operation === "approve") return "Approval fee";
  if (record.operation === "mint" || record.operation === "authorized_mint") {
    return "Minted";
  }
  if (record.operation === "burn" || record.operation === "authorized_burn") {
    return record.intent?.native ? "Withdrawn" : "Burned";
  }
  return BigInt(record.balanceEffect) > 0n ? "Received" : "Sent";
}

function historyIcon(record: HistoryRecord) {
  if (record.kind === "adjustment") return <IoWarningOutline aria-hidden="true" />;
  if (record.operation === "approve") return <IoCheckmark aria-hidden="true" />;
  return BigInt(record.balanceEffect) > 0n ? (
    <IoArrowDown aria-hidden="true" />
  ) : (
    <IoArrowUp aria-hidden="true" />
  );
}

function historyDirection(record: HistoryRecord): "incoming" | "outgoing" | "neutral" {
  const effect = BigInt(record.balanceEffect);
  return effect > 0n ? "incoming" : effect < 0n ? "outgoing" : "neutral";
}

function historyAmount(record: HistoryRecord): string {
  const effect = BigInt(record.balanceEffect);
  const units =
    record.kind === "adjustment" || record.operation === "approve"
      ? (effect < 0n ? -effect : effect).toString()
      : record.amount;
  const sign = effect > 0n ? "+" : effect < 0n ? "-" : "";
  return `${sign}${formatTokenAmount(units, record.decimals)}`;
}

function historyCounterparty(record: HistoryRecord): string {
  if (record.kind === "adjustment") return record.detail;
  if (record.intent) {
    return record.intent.addressLabel
      ? `${record.intent.contactName} / ${record.intent.addressLabel}`
      : record.intent.contactName;
  }
  const address =
    BigInt(record.balanceEffect) > 0n
      ? historyAddressText(record.from)
      : historyAddressText(record.to);
  return address ?? historyNetwork(record);
}

function historyNetwork(record: HistoryRecord): string {
  if (record.kind === "adjustment") return "Ledger reconciliation";
  const network = record.intent?.network ?? record.native?.network ?? "internet_computer";
  return network
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactHistoryText(value: string): string {
  return value.length > 58 ? `${value.slice(0, 34)}...${value.slice(-16)}` : value;
}

function verificationLabel(value: string, customLedger = false): string {
  if (value === "pending") {
    return customLedger
      ? "Local receipt; pending ledger scan"
      : "Pending ledger verification";
  }
  if (value === "prebaseline") return "Recorded before history baseline";
  if (value === "unverified_scan_limit") return "Not fully verified";
  return "Verified";
}

function adjustmentLabel(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function historyStateLabel(value: HistoryStatus["ledgers"][number]["state"]): string {
  if (value === "waiting_for_index") return "Waiting for ledger index";
  if (value === "permission_required") return "History access required";
  if (value === "catching_up") return "Loading more activity";
  if (value === "syncing") return "Syncing activity";
  if (value === "degraded") return "History needs attention";
  return "Activity is current";
}

function WalletDeposit({
  catalog,
  ledger,
  onBack,
  onRefresh,
  owner,
  publicNative,
  publicNativeBusy,
  publicNativeError,
  refreshBusy,
}: {
  catalog: CatalogLedger | null;
  ledger: WalletLedger;
  onBack: () => void;
  onRefresh: () => void;
  owner: string;
  publicNative: PublicNativeDeposit | null;
  publicNativeBusy: boolean;
  publicNativeError: string | null;
  refreshBusy: boolean;
}) {
  const route = catalog?.nativeRoute ?? null;
  const icAddress = icrcDepositAddress(owner);
  const backendNative =
    route?.kind === "ckbtc" || route?.kind === "ckdoge"
      ? ledger.nativeAddress
      : null;
  const nativeAddress = backendNative ?? publicNative?.address ?? null;
  const nativeError =
    route?.kind === "ckbtc" || route?.kind === "ckdoge"
      ? ledger.nativeAddressError
      : publicNativeError;
  const nativeBusy =
    route?.kind === "ckbtc" || route?.kind === "ckdoge"
      ? refreshBusy && !nativeAddress
      : publicNativeBusy;
  const contractMethod =
    route?.kind === "ckerc20"
      ? "depositErc20"
      : publicNative?.helperMode === "legacy"
        ? "deposit"
        : "depositEth";

  return (
    <WalletFallbackViewContext.Provider
      value={walletTileView("receive", ledger.id)}
    >
      <section className="wallet-deposit" aria-label="Deposit addresses">
      <header className="wallet-deposit-toolbar">
        <IconButton label="Back to tokens" onClick={onBack}>
          <IoArrowBack />
        </IconButton>
        <TokenMark logo={ledger.logo} symbol={ledger.symbol ?? "?"} />
        <span className="wallet-deposit-title">
          <strong>{ledger.symbol ?? ledger.name ?? "Token"}</strong>
          <small>{catalog === null ? "Custom ledger deposit" : "Deposit"}</small>
        </span>
        <span className="wallet-toolbar-spacer" />
        {ledger.nativeRefreshError ? (
          <IoAlertCircleOutline
            className="wallet-deposit-refresh-error"
            aria-label={ledger.nativeRefreshError}
            title={ledger.nativeRefreshError}
          />
        ) : null}
        <button
          className="nt-button nt-button--secondary nt-button--sm wallet-deposit-refresh-button"
          disabled={refreshBusy}
          aria-label="Refresh deposits and balance"
          onClick={onRefresh}
          type="button"
        >
          {refreshBusy ? <span className="wallet-spinner" /> : <IoRefresh />}
          <span>Refresh</span>
        </button>
      </header>

      <div className="wallet-deposit-routes">
        <article className="wallet-deposit-route">
          <div className="wallet-deposit-route-heading">
            <IoGlobeOutline aria-hidden="true" />
            <span>
              <strong>Internet Computer</strong>
              <small>ICRC-1 account</small>
            </span>
          </div>
          <CopyValue
            label={`Copy ${ledger.symbol ?? "token"} ICRC account`}
            value={icAddress}
          />
        </article>

        {route ? (
          <article className="wallet-deposit-route">
            <div className="wallet-deposit-route-heading">
              <IoGlobeOutline aria-hidden="true" />
              <span>
                <strong>{destinationLabels[route.originNetwork]}</strong>
                <small>
                  {route.kind === "cketh" || route.kind === "ckerc20"
                    ? "Deposit contract"
                    : "Deposit address"}
                </small>
              </span>
            </div>

            {nativeBusy ? (
              <div className="wallet-deposit-loading">
                <span className="wallet-spinner" />
              </div>
            ) : nativeAddress ? (
              publicNative?.kind === "contract" ? (
                <div className="wallet-deposit-contract">
                  {publicNative.helperMode ? (
                    <EthereumDepositControl
                      deposit={publicNative}
                      erc20={route.kind === "ckerc20"}
                      ledger={ledger}
                      onRefresh={onRefresh}
                      owner={owner}
                    />
                  ) : null}
                  <details
                    className="wallet-contract-details"
                  >
                    <summary>
                      <span>Contract details</span>
                      <IoChevronForward aria-hidden="true" />
                    </summary>
                    <div className="wallet-contract-detail-body">
                      <CopyDatum label="Deposit helper" value={nativeAddress} />
                      {publicNative.tokenContract ? (
                        <CopyDatum
                          label="Token contract"
                          value={publicNative.tokenContract}
                        />
                      ) : null}
                      <CopyDatum
                        label="Recipient"
                        value={ethereumPrincipalWord(owner)}
                      />
                      {publicNative.helperMode === "subaccount" ? (
                        <CopyDatum
                          label="Subaccount"
                          value={defaultSubaccountWord()}
                        />
                      ) : null}
                      <p className="wallet-deposit-warning">
                        Call <code>{contractMethod}</code> on this contract. A
                        direct token transfer cannot be credited.
                      </p>
                    </div>
                  </details>
                </div>
              ) : (
                <>
                  <CopyValue
                    label={`Copy ${destinationLabels[route.originNetwork]} address`}
                    value={nativeAddress}
                  />
                  {route.kind === "ckbtc" || route.kind === "ckdoge" ? (
                    <UtxoDepositStatus
                      busy={refreshBusy}
                      ledger={ledger}
                      nativeSymbol={route.kind === "ckbtc" ? "BTC" : "DOGE"}
                      network={destinationLabels[route.originNetwork]}
                    />
                  ) : null}
                </>
              )
            ) : (
              <div className="wallet-deposit-unavailable" role="status">
                <IoAlertCircleOutline aria-hidden="true" />
                <span>{nativeError ?? "Deposit address is unavailable"}</span>
              </div>
            )}
          </article>
        ) : null}
      </div>
      </section>
    </WalletFallbackViewContext.Provider>
  );
}

function UtxoDepositStatus({
  busy,
  ledger,
  nativeSymbol,
  network,
}: {
  busy: boolean;
  ledger: WalletLedger;
  nativeSymbol: string;
  network: string;
}) {
  const progress = ledger.nativeDepositProgress;
  const checkedAt = progress?.checkedAt ?? ledger.nativeRefreshUpdatedAt;
  const hasRows =
    !!progress &&
    (progress.pending.length > 0 ||
      progress.processing.length > 0 ||
      progress.issues.length > 0 ||
      progress.recentMinted.length > 0);
  const fallbackPending =
    progress?.pending.length === 0 &&
    progress.currentConfirmations !== null &&
    progress.requiredConfirmations !== null
      ? {
          confirmations: progress.currentConfirmations,
          requiredConfirmations: progress.requiredConfirmations,
        }
      : null;

  return (
    <div className="wallet-utxo-status" aria-live="polite">
      <div className="wallet-utxo-status-heading">
        <span className="wallet-utxo-status-icon">
          {busy ? (
            <span className="wallet-spinner" />
          ) : progress?.pending.length || fallbackPending ? (
            <IoTimeOutline aria-hidden="true" />
          ) : (
            <IoCheckmarkCircleOutline aria-hidden="true" />
          )}
        </span>
        <span>
          <strong>{network} deposits</strong>
          <small>
            {busy
              ? "Checking the minter"
              : checkedAt
                ? `Checked ${formatDepositTime(checkedAt)}`
                : "Not checked yet"}
          </small>
        </span>
      </div>

      {progress?.pending.map((deposit) => {
        const percent = confirmationPercent(
          deposit.confirmations,
          deposit.requiredConfirmations,
        );
        const remaining = confirmationsRemaining(
          deposit.confirmations,
          deposit.requiredConfirmations,
        );
        return (
          <div
            className="wallet-utxo-row is-pending"
            key={`pending:${deposit.txid}:${deposit.vout}`}
          >
            <div className="wallet-utxo-row-line">
              <strong>
                {formatTokenAmount(deposit.value, ledger.decimals ?? 8)}{" "}
                {nativeSymbol}
              </strong>
              <span>
                {deposit.confirmations} of {deposit.requiredConfirmations}
              </span>
            </div>
            <div
              aria-label={`${deposit.confirmations} of ${deposit.requiredConfirmations} confirmations`}
              aria-valuemax={Number(deposit.requiredConfirmations)}
              aria-valuemin={0}
              aria-valuenow={Math.min(
                Number(deposit.confirmations),
                Number(deposit.requiredConfirmations),
              )}
              className="wallet-utxo-meter"
              role="progressbar"
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            <div className="wallet-utxo-row-meta">
              <code title={`${deposit.txid}:${deposit.vout}`}>
                {depositOutpoint(deposit)}
              </code>
              <small>
                {remaining === "0"
                  ? "Ready to mint"
                  : `${remaining} confirmation${remaining === "1" ? "" : "s"} left`}
              </small>
            </div>
          </div>
        );
      })}

      {fallbackPending ? (
        <FallbackConfirmationStatus
          confirmations={fallbackPending.confirmations}
          requiredConfirmations={fallbackPending.requiredConfirmations}
        />
      ) : null}

      {progress?.processing.map((deposit) => (
        <div
          className="wallet-utxo-row is-processing"
          key={`processing:${deposit.txid}:${deposit.vout}`}
        >
          <div className="wallet-utxo-row-line">
            <strong>
              {formatTokenAmount(deposit.value, ledger.decimals ?? 8)}{" "}
              {nativeSymbol}
            </strong>
            <span>Minting {ledger.symbol ?? "token"}</span>
          </div>
          <div className="wallet-utxo-row-meta">
            <code title={`${deposit.txid}:${deposit.vout}`}>
              {depositOutpoint(deposit)}
            </code>
            <small>Verified</small>
          </div>
        </div>
      ))}

      {progress?.issues.map((issue) => (
        <div
          className="wallet-utxo-row is-issue"
          key={`issue:${issue.txid}:${issue.vout}`}
        >
          <div className="wallet-utxo-row-line">
            <strong>
              {formatTokenAmount(issue.value, ledger.decimals ?? 8)}{" "}
              {nativeSymbol}
            </strong>
            <span>{depositIssueLabel(issue.kind)}</span>
          </div>
          <div className="wallet-utxo-row-meta">
            <code title={`${issue.txid}:${issue.vout}`}>
              {depositOutpoint(issue)}
            </code>
            <small>{issue.earliestRetry ? "Retry scheduled" : "Needs attention"}</small>
          </div>
        </div>
      ))}

      {progress?.recentMinted.map((deposit) => (
        <div
          className="wallet-utxo-row is-minted"
          key={`minted:${deposit.txid}:${deposit.vout}`}
        >
          <div className="wallet-utxo-row-line">
            <strong>
              {formatTokenAmount(
                deposit.mintedAmount,
                ledger.decimals ?? 8,
              )}{" "}
              {ledger.symbol ?? "token"}
            </strong>
            <span>Credited</span>
          </div>
          <div className="wallet-utxo-row-meta">
            <code title={`${deposit.txid}:${deposit.vout}`}>
              {depositOutpoint(deposit)}
            </code>
            <small>{formatDepositTime(deposit.mintedAt)}</small>
          </div>
        </div>
      ))}

      {!hasRows && !fallbackPending ? (
        <div className="wallet-utxo-empty">
          <IoCheckmarkCircleOutline aria-hidden="true" />
          <span>
            <strong>No incoming deposits detected</strong>
            <small>New transfers appear here after a refresh.</small>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function FallbackConfirmationStatus({
  confirmations,
  requiredConfirmations,
}: {
  confirmations: string;
  requiredConfirmations: string;
}) {
  const percent = confirmationPercent(confirmations, requiredConfirmations);
  const remaining = confirmationsRemaining(confirmations, requiredConfirmations);
  return (
    <div className="wallet-utxo-row is-pending">
      <div className="wallet-utxo-row-line">
        <strong>Deposit detected</strong>
        <span>
          {confirmations} of {requiredConfirmations}
        </span>
      </div>
      <div
        aria-label={`${confirmations} of ${requiredConfirmations} confirmations`}
        aria-valuemax={Number(requiredConfirmations)}
        aria-valuemin={0}
        aria-valuenow={Math.min(
          Number(confirmations),
          Number(requiredConfirmations),
        )}
        className="wallet-utxo-meter"
        role="progressbar"
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="wallet-utxo-row-meta">
        <small>
          {remaining} confirmation{remaining === "1" ? "" : "s"} left
        </small>
      </div>
    </div>
  );
}

function depositIssueLabel(kind: WalletDepositIssueKind): string {
  switch (kind) {
    case "value_too_small":
      return "Below minimum";
    case "tainted":
      return "Compliance check failed";
    case "quarantined":
      return "Held for review";
  }
}

function formatDepositTime(value: string): string {
  try {
    const milliseconds = BigInt(value) / 1_000_000n;
    const date = new Date(Number(milliseconds));
    if (Number.isNaN(date.getTime())) return "recently";
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "recently";
  }
}

type WalletEthereumDepositPhase =
  | EthereumDepositPhase
  | "waiting-mint"
  | "minted";

function EthereumDepositControl({
  deposit,
  erc20,
  ledger,
  onRefresh,
  owner,
}: {
  deposit: PublicNativeDeposit;
  erc20: boolean;
  ledger: WalletLedger;
  onRefresh: () => void;
  owner: string;
}) {
  const { openInTile, surface } = useWalletSurface();
  const fallbackView = useContext(WalletFallbackViewContext);
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<WalletEthereumDepositPhase | null>(null);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const [balanceBefore, setBalanceBefore] = useState<bigint | null>(null);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const symbol = ledger.symbol ?? "token";
  const decimals = ledger.decimals;
  let amountUnits: bigint | null = null;
  let amountError: string | null = null;

  if (amount.trim() && decimals === null) {
    amountError = "Token decimals are not available";
  } else if (amount.trim() && decimals !== null) {
    try {
      amountUnits = BigInt(parseTokenAmount(amount, decimals));
    } catch (reason) {
      amountError = errorMessage(reason);
    }
  }

  useEffect(() => {
    if (phase !== "waiting-mint" || balanceBefore === null) return;
    if (ledger.balance !== null && BigInt(ledger.balance) > balanceBefore) {
      setPhase("minted");
      return;
    }
    const timer = window.setInterval(onRefresh, 60_000);
    return () => window.clearInterval(timer);
  }, [balanceBefore, ledger.balance, onRefresh, phase]);

  const submit = async () => {
    if (
      amountUnits === null ||
      decimals === null ||
      !deposit.helperMode ||
      !deposit.minterAddress ||
      (erc20 && !deposit.tokenContract)
    ) {
      return;
    }
    if (surface === "tray") {
      setBusy(true);
      setDepositError(null);
      try {
        await openInTile(fallbackView);
      } catch (reason) {
        setDepositError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
      return;
    }
    const startingBalance = BigInt(ledger.balance ?? "0");
    setBusy(true);
    setBalanceBefore(startingBalance);
    setDepositError(null);
    setTransactionHash(null);
    setPhase("connecting");
    let connection: Awaited<ReturnType<typeof connectEthereumProvider>> | null =
      null;
    try {
      connection = await connectEthereumProvider();
      const result = await submitEthereumDeposit({
        amount: amountUnits,
        helperMode: deposit.helperMode,
        helperAddress: deposit.address,
        minterAddress: deposit.minterAddress,
        provider: connection.provider,
        onProgress: (progress) => {
          setPhase(progress.phase);
          if (progress.transactionHash) {
            setTransactionHash(progress.transactionHash);
          }
        },
        principal: ethereumPrincipalWord(owner),
        subaccount: defaultSubaccountWord(),
        tokenAddress: erc20 ? deposit.tokenContract : null,
      });
      setTransactionHash(result.transactionHash);
      setPhase("waiting-mint");
      onRefresh();
    } catch (reason) {
      setDepositError(errorMessage(reason));
      setPhase(null);
    } finally {
      await connection?.close().catch(() => undefined);
      setBusy(false);
    }
  };

  const waiting = phase === "waiting-mint";
  const inputDisabled = busy || waiting;

  return (
    <div className="wallet-ethereum-deposit">
      {surface === "tray" ? (
        <button
          className="nt-button nt-button--secondary nt-button--sm wallet-metamask-button"
          onClick={() => void openInTile(fallbackView)}
          type="button"
        >
          <IoOpenOutline aria-hidden="true" />
          Continue deposit in Wallet
        </button>
      ) : (
        <>
          <div className="wallet-ethereum-form">
            <label className="wallet-ethereum-amount">
              <input
                aria-label={`Amount of ${symbol} to deposit`}
                aria-invalid={amountError ? "true" : undefined}
                autoComplete="off"
                disabled={inputDisabled}
                inputMode="decimal"
                onChange={(event) => {
                  setAmount(event.target.value);
                  if (phase === "minted") setPhase(null);
                  setDepositError(null);
                }}
                placeholder="0"
                spellCheck={false}
                value={amount}
              />
              <strong>{symbol}</strong>
            </label>
            <button
              className="nt-button nt-button--sm wallet-metamask-button"
              disabled={
                inputDisabled ||
                amountUnits === null ||
                amountError !== null ||
                !deposit.minterAddress ||
                (erc20 && !deposit.tokenContract)
              }
              onClick={() => void submit()}
              type="button"
            >
              {busy ? (
                <span className="wallet-spinner" />
              ) : (
                <IoWalletOutline aria-hidden="true" />
              )}
              Deposit with MetaMask
            </button>
          </div>
          {amountError ? (
            <span className="wallet-ethereum-error">{amountError}</span>
          ) : null}
        </>
      )}
      {phase || depositError ? (
        <div
          className={`wallet-ethereum-status${
            depositError ? " is-error" : phase === "minted" ? " is-complete" : ""
          }`}
          role={depositError ? "alert" : "status"}
        >
          {depositError ? (
            <IoAlertCircleOutline aria-hidden="true" />
          ) : phase === "minted" ? (
            <IoCheckmark aria-hidden="true" />
          ) : (
            <span className="wallet-spinner" />
          )}
          <span>
            <strong>
              {depositError ?? ethereumDepositPhaseLabel(phase, symbol)}
            </strong>
            {transactionHash ? (
              <code title={transactionHash}>{compactAddress(transactionHash)}</code>
            ) : null}
          </span>
          {transactionHash ? (
            <CopyButton
              label="Copy Ethereum transaction hash"
              value={transactionHash}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ethereumDepositPhaseLabel(
  phase: WalletEthereumDepositPhase | null,
  symbol: string,
): string {
  switch (phase) {
    case "connecting":
      return "Connecting MetaMask";
    case "switching-network":
      return "Switching to Ethereum Mainnet";
    case "checking-allowance":
      return "Checking token allowance";
    case "clearing-allowance":
      return "Confirming allowance reset";
    case "approving":
      return `Confirming ${symbol} approval`;
    case "submitting":
      return "Confirm deposit in MetaMask";
    case "confirming":
      return "Confirming on Ethereum";
    case "waiting-mint":
      return `Waiting for ${symbol} mint`;
    case "minted":
      return `${symbol} credited`;
    default:
      return "Preparing deposit";
  }
}

function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="wallet-copy-value">
      <code title={value}>{value}</code>
      <CopyButton label={label} value={value} />
    </div>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const { openInTile, surface } = useWalletSurface();
  const fallbackView = useContext(WalletFallbackViewContext);
  const actionLabel =
    surface === "tray" ? `${label} in the full Wallet` : label;
  return (
    <IconButton
      label={actionLabel}
      onClick={() => {
        const operation =
          surface === "tray"
            ? openInTile(fallbackView)
            : copyToClipboard(value);
        void operation.catch(() => undefined);
      }}
    >
      {surface === "tray" ? <IoOpenOutline /> : <IoCopyOutline />}
    </IconButton>
  );
}

function CopyDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="wallet-copy-datum">
      <span>{label}</span>
      <CopyValue label={`Copy ${label.toLowerCase()}`} value={value} />
    </div>
  );
}

function WalletDestinations({
  busy,
  catalog,
  contactsBusy,
  ledger,
  network,
  onBack,
  onCancelTransfer,
  onContacts,
  onNetwork,
  onQuery,
  onRefresh,
  onSelect,
  onSubmit,
  onTransferAmount,
  page,
  query,
  transferAmount,
  transferBusy,
  transferCandidate,
  transferReceipt,
}: {
  busy: boolean;
  catalog: CatalogLedger | null;
  contactsBusy: boolean;
  ledger: WalletLedger;
  network: CatalogNetwork;
  onBack: () => void;
  onCancelTransfer: () => void;
  onContacts: () => void;
  onNetwork: (network: CatalogNetwork) => void;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  onSelect: (candidate: WalletContactDestination) => void;
  onSubmit: () => void;
  onTransferAmount: (value: string) => void;
  page: WalletContactDestinationsPage | null;
  query: string;
  transferAmount: string;
  transferBusy: boolean;
  transferCandidate: WalletContactDestination | null;
  transferReceipt: WalletTransferReceipt | null;
}) {
  const fallbackView = walletTileView("send", ledger.id);
  if (transferCandidate) {
    return (
      <WalletFallbackViewContext.Provider value={fallbackView}>
        <WalletTransfer
          amount={transferAmount}
          busy={transferBusy}
          candidate={transferCandidate}
          catalog={catalog}
          ledger={ledger}
          onAmount={onTransferAmount}
          onBack={onCancelTransfer}
          onSubmit={onSubmit}
          receipt={transferReceipt}
        />
      </WalletFallbackViewContext.Provider>
    );
  }

  const networks = catalog?.networks ?? ["internet_computer"];
  const action = network === "internet_computer" ? "Send" : "Withdraw";
  return (
    <WalletFallbackViewContext.Provider value={fallbackView}>
      <section className="wallet-destinations" aria-label="Contact destinations">
      <header className="wallet-destination-toolbar">
        <IconButton label="Back to tokens" onClick={onBack}>
          <IoArrowBack />
        </IconButton>
        <TokenMark logo={ledger.logo} symbol={ledger.symbol} />
        <span className="wallet-destination-title">
          <strong>{action} {ledger.symbol ?? ledger.name ?? "token"}</strong>
          <small>
            {page?.total ?? "0"} compatible contact
            {page?.total === "1" ? "" : "s"}
          </small>
        </span>
        <select
          aria-label="Transfer network"
          className="wallet-network-select"
          onChange={(event) => onNetwork(event.target.value as CatalogNetwork)}
          value={network}
        >
          {networks.map((candidate) => (
            <option
              disabled={!canTransferNetwork(candidate, catalog)}
              key={candidate}
              value={candidate}
            >
              {destinationLabels[candidate]}
            </option>
          ))}
        </select>
        <span className="wallet-toolbar-spacer" />
        <IconButton
          active={contactsBusy}
          className="wallet-destination-add"
          label="Add contact"
          onClick={onContacts}
        >
          <IoPersonAddOutline />
        </IconButton>
        <IconButton
          active={busy}
          className="wallet-destination-refresh"
          label="Refresh destinations"
          onClick={onRefresh}
        >
          <IoRefresh />
        </IconButton>
      </header>
      <label className="wallet-destination-search">
        <IoSearchOutline aria-hidden="true" />
        <input
          aria-label="Search contact destinations"
          autoComplete="off"
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search contacts"
          type="search"
          value={query}
        />
      </label>
      <div className="wallet-destination-list" aria-busy={busy}>
        {busy && !page ? (
          <div className="wallet-empty"><span className="wallet-spinner" /></div>
        ) : !page || page.destinations.length === 0 ? (
          <div className="wallet-empty">
            <IoPeopleOutline aria-hidden="true" />
            <span>{query ? "No matching destinations" : "No compatible destinations"}</span>
          </div>
        ) : (
          <DestinationGroup destinations={page.destinations} onSelect={onSelect} />
        )}
      </div>
      </section>
    </WalletFallbackViewContext.Provider>
  );
}

function DestinationGroup({
  destinations,
  onSelect,
}: {
  destinations: WalletContactDestination[];
  onSelect: (candidate: WalletContactDestination) => void;
}) {
  if (destinations.length === 0) return null;
  return (
    <section className="wallet-destination-group">
      {destinations.map((candidate) => {
        const destination = walletDestinationText(candidate.destination);
        return (
          <article
            className="wallet-destination-row"
            key={`${candidate.contactId}:${candidate.addressId}`}
          >
            <button
              aria-label={`Send to ${candidate.contactName}`}
              className="wallet-destination-choice"
              onClick={() => onSelect(candidate)}
              type="button"
            >
              <span className="wallet-destination-person">
                <span>
                  <strong>{candidate.contactName}</strong>
                  {candidate.preferred ? <IoStar aria-label="Preferred" /> : null}
                </span>
                <small>
                  {candidate.label ??
                    destinationLabels[candidate.destination.network]}
                </small>
                <code title={destination}>{compactAddress(destination)}</code>
              </span>
              <span className="wallet-destination-network">
                {destinationLabels[candidate.destination.network]}
              </span>
              <IoChevronForward aria-hidden="true" />
            </button>
            <CopyButton
              label={`Copy ${candidate.contactName} destination`}
              value={destination}
            />
          </article>
        );
      })}
    </section>
  );
}

function WalletTransfer({
  amount,
  busy,
  candidate,
  catalog,
  ledger,
  onAmount,
  onBack,
  onSubmit,
  receipt,
}: {
  amount: string;
  busy: boolean;
  candidate: WalletContactDestination;
  catalog: CatalogLedger | null;
  ledger: WalletLedger;
  onAmount: (value: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  receipt: WalletTransferReceipt | null;
}) {
  const destination = walletDestinationText(candidate.destination);
  const native = candidate.destination.network !== "internet_computer";
  const custom = catalog === null;
  const erc20 = catalog?.nativeRoute?.kind === "ckerc20";
  const action = native ? "Withdraw" : "Send";
  const decimals = ledger.decimals;
  const symbol = ledger.symbol ?? "units";
  const available =
    ledger.balance === null || decimals === null
      ? null
      : formatTokenAmount(ledger.balance, decimals);
  const ledgerFee =
    ledger.fee === null || decimals === null
      ? null
      : formatTokenAmount(ledger.fee, decimals);
  const maximum = maxTransferAmount(ledger);
  let amountError: string | null = null;
  if (amount.trim()) {
    try {
      parseTransferAmount(amount, ledger);
    } catch (reason) {
      amountError = errorMessage(reason);
    }
  }

  return (
    <section className="wallet-transfer" aria-label={`${action} token`}>
      <header className="wallet-destination-toolbar">
        <IconButton label="Back to destinations" onClick={onBack}>
          <IoArrowBack />
        </IconButton>
        <TokenMark logo={ledger.logo} symbol={ledger.symbol} />
        <span className="wallet-destination-title">
          <strong>{action} {symbol}</strong>
          <small>{destinationLabels[candidate.destination.network]}</small>
        </span>
      </header>

      <div className="wallet-transfer-body">
        <div className="wallet-transfer-recipient">
          <span className="wallet-transfer-label">To</span>
          <span className="wallet-transfer-recipient-copy">
            <strong>{candidate.contactName}</strong>
            <small>
              {candidate.label ??
                destinationLabels[candidate.destination.network]}
            </small>
            <code title={destination}>{compactAddress(destination)}</code>
          </span>
          <CopyButton
            label={`Copy ${candidate.contactName} destination`}
            value={destination}
          />
        </div>

        <div className="wallet-amount-field">
          <div className="wallet-amount-heading">
            <label htmlFor="wallet-transfer-amount">Amount</label>
            <button
              className="wallet-max-button"
              disabled={busy || receipt !== null || maximum === null}
              onClick={() => maximum !== null && onAmount(maximum)}
              type="button"
            >
              Max
            </button>
          </div>
          <label className="wallet-amount-control">
            <input
              id="wallet-transfer-amount"
              aria-label="Transfer amount"
              aria-describedby={amountError ? "wallet-amount-error" : undefined}
              aria-invalid={amountError ? "true" : undefined}
              autoFocus
              autoComplete="off"
              disabled={busy || receipt !== null}
              inputMode="decimal"
              onChange={(event) => onAmount(event.target.value)}
              placeholder="0"
              spellCheck={false}
              value={amount}
            />
            <strong>{symbol}</strong>
          </label>
          {amountError ? (
            <span className="wallet-amount-error" id="wallet-amount-error">
              {amountError}
            </span>
          ) : null}
          <dl className="wallet-transfer-details">
            {custom ? (
              <div className="wallet-transfer-ledger">
                <dt>Custom ledger canister</dt>
                <dd>{ledger.principal}</dd>
              </div>
            ) : null}
            <div>
              <dt>Available</dt>
              <dd>{available === null ? "-" : `${available} ${symbol}`}</dd>
            </div>
            <div>
              <dt>{native ? "Approval fee" : "Fee"}</dt>
              <dd>{ledgerFee === null ? "-" : `${ledgerFee} ${symbol}`}</dd>
            </div>
            {native ? (
              <div>
                <dt>Network fee</dt>
                <dd>{erc20 ? "Paid in ckETH" : "From amount"}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        {receipt ? (
          <div className="wallet-transfer-receipt" role="status">
            <IoCheckmark aria-hidden="true" />
            <span>
              <strong>
                {receipt.native
                  ? "Withdrawal queued"
                  : receipt.duplicate
                    ? "Transfer already recorded"
                    : "Transfer sent"}
              </strong>
              <small>
                {receipt.native ? "Request" : "Block"} {receipt.blockIndex}
                {receipt.secondaryBlockIndex
                  ? ` / gas burn ${receipt.secondaryBlockIndex}`
                  : ""}
              </small>
            </span>
          </div>
        ) : null}

        <footer className="wallet-transfer-actions">
          {receipt ? (
            <button
              className="nt-button nt-button--sm"
              onClick={onBack}
              type="button"
            >
              <IoCheckmark aria-hidden="true" />
              Done
            </button>
          ) : (
            <button
              className="nt-button nt-button--sm"
              disabled={
                busy || amount.trim().length === 0 || amountError !== null
              }
              onClick={onSubmit}
              type="button"
            >
              {busy ? (
                <span className="wallet-spinner" />
              ) : (
                <IoSend aria-hidden="true" />
              )}
              {action}
            </button>
          )}
        </footer>
      </div>
    </section>
  );
}

function IconButton({
  active = false,
  children,
  className = "",
  label,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      className={`nt-icon-button ${className}${active ? " is-active" : ""}`}
      title={label}
      type={type}
      {...props}
    >
      {active ? <span className="wallet-spinner" /> : children}
    </button>
  );
}

function canTransferNetwork(
  network: CatalogNetwork,
  catalog: CatalogLedger | null,
): boolean {
  if (network === "internet_computer") return true;
  return (
    catalog?.nativeRoute?.nativeActionsAvailable === true &&
    catalog.nativeRoute.originNetwork === network
  );
}

function networkVariant(network: CatalogNetwork): JsonObject {
  return { [network]: null };
}

function destinationVariant(destination: WalletDestination): JsonObject {
  return destination.network === "internet_computer"
    ? { internet_computer: destination.account }
    : { [destination.network]: destination.address };
}

function asTransferReceipt(value: JsonValue): WalletTransferReceipt {
  const record = requiredObject(value, "wallet transfer receipt");
  if (
    typeof record.duplicate !== "boolean" ||
    typeof record.native !== "boolean"
  ) {
    throw new Error("Invalid wallet transfer receipt");
  }
  return {
    blockIndex: requiredNat(record.block_index, "transfer block index"),
    secondaryBlockIndex: optionalNat(record.secondary_block_index),
    duplicate: record.duplicate,
    native: record.native,
  };
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function optionalNat(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredNat(value, "natural number");
}

function requiredNat(value: unknown, label: string): string {
  try {
    const parsed = BigInt(value as string | number | bigint);
    if (parsed < 0n) throw new Error("negative");
    return parsed.toString();
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function compactPrincipal(value: string): string {
  return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-7)}` : value;
}

function customLedgerIds(
  snapshot: WalletSnapshot,
  catalog: CatalogLedger[],
): string[] {
  const presets = new Set(catalog.map((ledger) => ledger.principal));
  return snapshot.ledgers
    .map((ledger) => ledger.principal)
    .filter((principal) => !presets.has(principal));
}

function compactAddress(value: string): string {
  return value.length > 46 ? `${value.slice(0, 24)}...${value.slice(-14)}` : value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isJsonObject(error)) {
    if (typeof error.shortMessage === "string") return error.shortMessage;
    if (typeof error.message === "string") return error.message;
  }
  return typeof error === "string" ? error : "Unexpected error";
}

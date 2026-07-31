import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createRoot } from "react-dom/client";
import type { IconType } from "react-icons";
import {
  IoArrowUndoOutline,
  IoCheckmark,
  IoClose,
  IoCopyOutline,
  IoFlagOutline,
  IoRefreshOutline,
  IoSwapVerticalOutline,
  IoWarningOutline,
} from "react-icons/io5";
import {
  FaChessBishop,
  FaChessKing,
  FaChessKnight,
  FaChessPawn,
  FaChessQueen,
  FaChessRook,
} from "react-icons/fa6";
import {
  copyToClipboard,
  isJsonObject,
  listBackendCallReservations,
  loadNeutronCanisterId,
  loadTileContext,
  onAppStateChange,
  querySelf,
  requestBackendCallReservations,
  toError,
  updateSelf,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import { CHESS_STATE_TOPIC } from "./agent_tools.ts";
import {
  parseGame,
  parseOptionalGame,
  type ChessColor,
  type ChessGame,
  type ChessLegalMove,
  type ChessMode,
  type ChessMove,
  type ComputerLevel,
  type PieceCode,
  type PromotionPiece,
} from "./chess_api.ts";
import {
  beginRefresh,
  createRefreshLatch,
  queueRefresh,
  shouldDrainRefresh,
} from "./refresh_latch.ts";
import { BrowserComputer } from "./browser_computer.ts";
import { setPieceDragImage } from "./drag_image.ts";
import {
  MAX_INVITE_CODE_LENGTH,
  createGameId,
  decodeInvite,
  encodeInvite,
} from "./invite_code.ts";
import {
  hasRemotePushReservation,
  parseRemotePushTarget,
  remotePushAttemptKey,
  remotePushReservationRequest,
  remoteJoinRequest,
  type RemotePushTarget,
} from "./remote_connection.ts";
import "./style.scss";

const CHESS_FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const DRAG_MIME = "text/plain";
// Periodic refreshes only query this Neutron's local Chess cache. Remote
// changes arrive through paid protocol pushes.
const LOCAL_REFRESH_MS = 3_000;
const PROMOTION_CHOICES: PromotionPiece[] = ["q", "r", "b", "n"];
type PieceKind = "K" | "Q" | "R" | "B" | "N" | "P";
type SetupOpponent = "computer" | "local" | "remote";
type ColorChoice = ChessColor | "random";

const PIECE_ICONS: Record<PieceKind, IconType> = {
  K: FaChessKing,
  Q: FaChessQueen,
  R: FaChessRook,
  B: FaChessBishop,
  N: FaChessKnight,
  P: FaChessPawn,
};
const PIECE_NAMES: Record<PieceKind, string> = {
  K: "king",
  Q: "queen",
  R: "rook",
  B: "bishop",
  N: "knight",
  P: "pawn",
};

type PendingPromotion = {
  from: string;
  to: string;
  color: ChessColor;
};

export function App() {
  const context = useMemo(() => loadTileContext(), []);
  const tileId = context.instance ?? "standalone-chess-tile";
  const mountedRef = useRef(true);
  const gameRef = useRef<ChessGame | null>(null);
  const syncingEpochRef = useRef<number | null>(null);
  const ignoreClickRef = useRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const computerRef = useRef<BrowserComputer | null>(null);
  const computerRevisionRef = useRef<string | null>(null);
  const sessionEpochRef = useRef(0);
  const mutationRef = useRef<object | null>(null);
  const pushAccessAttemptRef = useRef<string | null>(null);
  const stateRefreshLatchRef = useRef(createRefreshLatch());
  const [game, setGame] = useState<ChessGame | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [opponent, setOpponent] = useState<SetupOpponent>("computer");
  const [colorChoice, setColorChoice] = useState<ColorChoice>("white");
  const [computerLevel, setComputerLevel] = useState<ComputerLevel>("medium");
  const [inviteInput, setInviteInput] = useState("");
  const [hostPrincipal, setHostPrincipal] = useState<string | null>(null);
  const [hostPrincipalError, setHostPrincipalError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [focusedSquare, setFocusedSquare] = useState("e2");
  const [busy, setBusy] = useState<string | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [newGameArmed, setNewGameArmed] = useState(false);
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  const [sessionRecoveryError, setSessionRecoveryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingPromotion, setPendingPromotion] =
    useState<PendingPromotion | null>(null);
  const [hostPushAccessRetry, setHostPushAccessRetry] =
    useState<RemotePushTarget | null>(null);
  const [guestRecoveryNeeded, setGuestRecoveryNeeded] = useState(false);

  const applyGame = useCallback((next: ChessGame) => {
    if (!mountedRef.current) return;
    const current = gameRef.current;
    if (current?.gameId === next.gameId && current.revision > next.revision) return;
    if (current?.gameId !== next.gameId) {
      computerRef.current?.dispose();
      computerRef.current = null;
      computerRevisionRef.current = null;
      setHostPushAccessRetry(null);
      setGuestRecoveryNeeded(false);
    }
    if (
      current?.gameId !== next.gameId ||
      current.revision !== next.revision ||
      current.turn !== next.turn ||
      next.status !== "active"
    ) {
      setSelected(null);
      setPendingPromotion(null);
    }
    gameRef.current = next;
    setGame(next);
    setSetupOpen(false);
    if (current?.gameId !== next.gameId) {
      setFlipped(next.localColor === "black");
      setFocusedSquare(next.legalMoves[0]?.from ?? "e1");
    }
  }, []);

  const loadGame = useCallback(
    async function loadGameRequest(initial = false) {
      const epoch = sessionEpochRef.current;
      const sameEpochRefreshActive = syncingEpochRef.current === epoch;
      if (initial) {
        if (sameEpochRefreshActive) return;
      } else if (
        !beginRefresh(stateRefreshLatchRef.current, sameEpochRefreshActive)
      ) {
        return;
      }
      syncingEpochRef.current = epoch;
      if (initial) setBusy("loading");
      try {
        const current = gameRef.current;
        const value = await querySelf("chess_get_game", [{ tile_id: tileId }], 30);
        if (epoch !== sessionEpochRef.current) return;
        const next = parseOptionalGame(value);
        if (next) {
          applyGame(next);
          if (next.mode === "remote_host" && next.remoteConnected) {
            // The local refresh can discover a newly joined guest, but it
            // never contacts that peer. Access preparation is a separate
            // one-shot owner-consent operation per bound game and guest.
            void prepareHostPushAccess(next);
          }
        } else if (initial && mountedRef.current) setSetupOpen(true);
        else if (current && mountedRef.current) {
          gameRef.current = null;
          setGame(null);
          setSetupOpen(true);
          setError("This tile's previous game is no longer available. Start a new game.");
        }
        if (initial && mountedRef.current) setInitialLoadFailed(false);
      } catch (reason) {
        const failure = toError(reason) as Error & { code?: string };
        if (epoch === sessionEpochRef.current && mountedRef.current && initial) {
          setError(failure.message || "Chess request failed");
          setInitialLoadFailed(true);
        }
      } finally {
        if (syncingEpochRef.current === epoch) syncingEpochRef.current = null;
        if (mountedRef.current && initial && epoch === sessionEpochRef.current) {
          setBusy(null);
        }
        if (shouldDrainRefresh(
          stateRefreshLatchRef.current,
          mountedRef.current,
          Boolean(mutationRef.current),
        )) {
          void loadGameRequest(false);
        }
      }
    },
    [applyGame, tileId],
  );

  async function prepareHostPushAccess(
    hostGame: ChessGame,
    force = false,
  ) {
    if (
      hostGame.mode !== "remote_host" ||
      !hostGame.remoteConnected ||
      !mountedRef.current
    ) {
      return;
    }
    try {
      const target = parseRemotePushTarget(
        await querySelf("chess_remote_push_target", [{ tile_id: tileId }], 30),
      );
      if (!target || target.gameId !== hostGame.gameId) return;
      const accessKey = remotePushAttemptKey(target);
      if (!force && pushAccessAttemptRef.current === accessKey) return;
      pushAccessAttemptRef.current = accessKey;
      setBusy("authorizing");

      const current = gameRef.current;
      if (
        current?.mode !== "remote_host" ||
        current.gameId !== target.gameId
      ) {
        return;
      }
      const existing = hasRemotePushReservation(
        await listBackendCallReservations(),
        target,
      );
      if (existing) {
        if (target.pendingRevision === null) {
          setHostPushAccessRetry(null);
          return;
        }
        applyGame(parseGame(await updateSelf(
          "chess_sync_game",
          [{ tile_id: tileId }],
          45,
        )));
      } else {
        const response = await requestBackendCallReservations(
          remotePushReservationRequest(tileId, target),
        );
        if (!isJsonObject(response)) {
          throw new Error("Invalid Chess access response");
        }
        if (!hasRemotePushReservation(response, target)) {
          throw new Error("Guest push access was not saved");
        }
        if (typeof response.callError === "string") {
          throw new Error(
            `Access was saved, but the pending Chess push failed: ${response.callError}`,
          );
        }
        if (response.callResult === undefined) {
          throw new Error("Access was saved, but Chess did not retry the pending push");
        }
        applyGame(parseGame(response.callResult));
      }
      setHostPushAccessRetry(null);
    } catch (reason) {
      if (!mountedRef.current) return;
      setHostPushAccessRetry(
        gameRef.current?.mode === "remote_host"
          ? await currentRemotePushTarget()
          : null,
      );
      setError(
        `Allow this Chess host to push paid updates to its guest: ${errorMessage(reason)}`,
      );
    } finally {
      if (mountedRef.current) {
        setBusy((current) => current === "authorizing" ? null : current);
      }
    }
  }

  async function currentRemotePushTarget(): Promise<RemotePushTarget | null> {
    try {
      return parseRemotePushTarget(
        await querySelf("chess_remote_push_target", [{ tile_id: tileId }], 30),
      );
    } catch {
      return null;
    }
  }

  async function recoverGuestState(manual = false) {
    if (manual) setBusy("recovering");
    try {
      const next = parseGame(
        await updateSelf("chess_sync_game", [{ tile_id: tileId }], 45),
      );
      applyGame(next);
      setGuestRecoveryNeeded(false);
      setError(null);
    } catch (reason) {
      if (!mountedRef.current) return;
      setGuestRecoveryNeeded(true);
      setError(
        `Chess could not reconcile the remote command outcome: ${errorMessage(reason)}`,
      );
    } finally {
      if (manual && mountedRef.current) {
        setBusy((current) => current === "recovering" ? null : current);
      }
    }
  }

  const requestStateRefresh = useCallback(() => {
    queueRefresh(stateRefreshLatchRef.current);
    if (!mutationRef.current) void loadGame(false);
  }, [loadGame]);

  const finishMutation = useCallback(
    (mutation: object, epoch: number) => {
      if (mutationRef.current !== mutation) return;
      mutationRef.current = null;
      if (mountedRef.current && epoch === sessionEpochRef.current) setBusy(null);
      if (shouldDrainRefresh(
        stateRefreshLatchRef.current,
        mountedRef.current,
        false,
      )) {
        void loadGame(false);
      }
    },
    [loadGame],
  );

  useEffect(() => {
    mountedRef.current = true;
    void loadGame(true);
    void loadHostPrincipal();
    return () => {
      mountedRef.current = false;
      computerRef.current?.dispose();
      computerRef.current = null;
    };
  }, [loadGame]);

  useEffect(
    () => onAppStateChange(CHESS_STATE_TOPIC, requestStateRefresh),
    [requestStateRefresh],
  );

  async function loadHostPrincipal() {
    setHostPrincipalError(null);
    try {
      const principal = await loadNeutronCanisterId();
      if (!mountedRef.current) return;
      setHostPrincipal(principal);
    } catch (reason) {
      if (!mountedRef.current) return;
      setHostPrincipal(null);
      setHostPrincipalError(errorMessage(reason));
    }
  }

  useEffect(() => {
    if (
      !game ||
      setupOpen ||
      (game.mode === "remote_host"
        ? game.status !== "waiting" && game.status !== "active"
        : game.mode === "remote_guest"
          ? game.status !== "active"
          : true)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      if (!mutationRef.current) void loadGame(false);
    }, LOCAL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [game?.gameId, game?.mode, game?.status, loadGame, setupOpen]);

  useEffect(() => {
    if (
      game?.mode === "remote_host" &&
      game.status === "waiting" &&
      hostPrincipalError
    ) {
      setError(`The invite cannot be created: ${hostPrincipalError}`);
    }
  }, [game?.mode, game?.status, hostPrincipalError]);

  useEffect(() => {
    if (!newGameArmed) return;
    const timer = window.setTimeout(() => setNewGameArmed(false), 3_000);
    return () => window.clearTimeout(timer);
  }, [newGameArmed]);

  useEffect(() => {
    if (game?.mode === "computer" && game.status === "active" && !setupOpen) return;
    computerRef.current?.dispose();
    computerRef.current = null;
  }, [game?.gameId, game?.mode, game?.status, setupOpen]);

  useEffect(() => {
    const history = historyRef.current;
    if (history) history.scrollTop = history.scrollHeight;
  }, [game?.history.length]);

  useEffect(() => {
    if (
      !game ||
      game.mode !== "computer" ||
      game.status !== "active" ||
      game.localColor === null ||
      game.turn === game.localColor ||
      busy !== null ||
      error !== null
    ) {
      return;
    }
    const computer = computerRef.current ?? new BrowserComputer();
    computerRef.current = computer;
    const key = `${game.gameId}:${game.revision}`;
    if (computerRevisionRef.current === key) return;
    computerRevisionRef.current = key;
    setBusy("computer");
    const snapshot = game;
    void computer
      .choose(snapshot)
      .then((move) => {
        const current = gameRef.current;
        if (
          !mountedRef.current ||
          !current ||
          current.gameId !== snapshot.gameId ||
          current.revision !== snapshot.revision
        ) {
          if (mountedRef.current && computerRevisionRef.current === key) {
            computerRevisionRef.current = null;
            setBusy(null);
          }
          return;
        }
        if (!move) {
          computerRevisionRef.current = null;
          setBusy(null);
          setError("The computer could not find a legal move");
          return;
        }
        submitMove(move.from, move.to, move.promotion, "computer");
      })
      .catch((reason) => {
        if (!mountedRef.current) return;
        const current = gameRef.current;
        if (
          !current ||
          current.gameId !== snapshot.gameId ||
          current.revision !== snapshot.revision
        ) {
          if (computerRevisionRef.current === key) {
            computerRevisionRef.current = null;
            setBusy(null);
          }
          return;
        }
        if (computerRevisionRef.current === key) {
          computerRevisionRef.current = null;
        }
        setBusy(null);
        setError(errorMessage(reason));
      });
  }, [busy, error, game]);

  const pieces = useMemo(
    () => (game ? piecesFromRows(game.rows) : new Map<string, PieceCode>()),
    [game],
  );
  const legalByFrom = useMemo(() => groupLegalMoves(game?.legalMoves ?? []), [game]);
  const displayFiles = flipped ? [...CHESS_FILES].reverse() : [...CHESS_FILES];
  const displayRanks = flipped
    ? [1, 2, 3, 4, 5, 6, 7, 8]
    : [8, 7, 6, 5, 4, 3, 2, 1];
  const lastMove = game?.history.at(-1) ?? null;
  const canMove = Boolean(game && canLocalMove(game) && busy === null);
  const selectedMoves = selected ? (legalByFrom.get(selected) ?? []) : [];
  const checkedKing = game?.inCheck ? findKing(pieces, game.turn) : null;
  const inviteCode =
    game?.mode === "remote_host" && hostPrincipal
      ? encodeInvite({
          version: 1,
          hostPrincipal,
          gameId: game.gameId,
        })
      : null;

  async function runUpdate(
    method: "chess_move" | "chess_action" | "chess_undo",
    request: JsonObject,
    busyKey: string,
  ) {
    if (mutationRef.current) return;
    const mutation = {};
    mutationRef.current = mutation;
    const epoch = sessionEpochRef.current;
    setBusy(busyKey);
    setError(null);
    try {
      const next = parseGame(await updateSelf(method, [request], 60));
      if (epoch === sessionEpochRef.current) applyGame(next);
    } catch (reason) {
      if (epoch !== sessionEpochRef.current) return;
      const failure = toError(reason) as Error & { code?: string };
      if (busyKey === "computer") computerRevisionRef.current = null;
      if (
        gameRef.current?.mode === "remote_guest" &&
        (method === "chess_move" || method === "chess_action") &&
        remoteCommandOutcomeUncertain(failure.code)
      ) {
        // A lost reply can hide a remotely committed command. Recover once
        // explicitly; this is never driven by the periodic local refresh.
        await recoverGuestState();
      } else {
        setError(failure.message || "Chess request failed");
        requestStateRefresh();
      }
    } finally {
      finishMutation(mutation, epoch);
    }
  }

  async function reconcileMutation(
    epoch: number,
    previousGameId: string | null,
    failureMessage: string,
  ) {
    try {
      const current = parseOptionalGame(
        await querySelf("chess_get_game", [{ tile_id: tileId }], 30),
      );
      if (epoch !== sessionEpochRef.current || !mountedRef.current) return;
      if (current && current.gameId !== previousGameId) {
        setError(null);
        setSessionRecoveryError(null);
        applyGame(current);
      } else {
        setError(failureMessage);
      }
    } catch (recoveryReason) {
      if (epoch !== sessionEpochRef.current || !mountedRef.current) return;
      setSessionRecoveryError(
        `${failureMessage} Chess could not confirm the tile's current game: ${errorMessage(recoveryReason)}`,
      );
    }
  }

  async function recoverTileSession() {
    if (mutationRef.current) return;
    const mutation = {};
    mutationRef.current = mutation;
    const epoch = sessionEpochRef.current;
    setBusy("loading");
    try {
      const current = parseOptionalGame(
        await querySelf("chess_get_game", [{ tile_id: tileId }], 30),
      );
      if (epoch !== sessionEpochRef.current || !mountedRef.current) return;
      setInitialLoadFailed(false);
      setSessionRecoveryError(null);
      setError(null);
      if (current) {
        applyGame(current);
      } else {
        gameRef.current = null;
        setGame(null);
        setSetupOpen(true);
      }
    } catch (reason) {
      if (epoch !== sessionEpochRef.current || !mountedRef.current) return;
      const message = `Chess still cannot confirm this tile's game: ${errorMessage(reason)}`;
      if (gameRef.current) setSessionRecoveryError(message);
      else {
        setInitialLoadFailed(true);
        setError(message);
      }
    } finally {
      finishMutation(mutation, epoch);
    }
  }

  async function startGame() {
    if (mutationRef.current) return;
    if (opponent === "remote" && !hostPrincipal) {
      setError(
        hostPrincipalError
          ? `The invite cannot be created: ${hostPrincipalError}`
          : "Neutron is still loading the principal needed for the invite",
      );
      return;
    }
    const mutation = {};
    mutationRef.current = mutation;
    const epoch = ++sessionEpochRef.current;
    const previousGameId = gameRef.current?.gameId ?? null;
    const mode: ChessMode =
      opponent === "local"
        ? "local"
        : opponent === "computer"
          ? "computer"
          : "remote_host";
    const localColor = mode === "local" ? null : chooseColor(colorChoice);
    setBusy("creating");
    setError(null);
    setSessionRecoveryError(null);
    setSelected(null);
    setPendingPromotion(null);
    try {
      const value = await updateSelf(
        "chess_create_game",
        [
          {
            tile_id: tileId,
            game_id: createGameId(),
            mode,
            ...(localColor ? { local_color: localColor } : {}),
            ...(mode === "computer" ? { computer_level: computerLevel } : {}),
          },
        ],
        60,
      );
      if (epoch === sessionEpochRef.current) {
        applyGame(parseGame(value));
      }
    } catch (reason) {
      if (epoch === sessionEpochRef.current) {
        await reconcileMutation(epoch, previousGameId, errorMessage(reason));
      }
    } finally {
      finishMutation(mutation, epoch);
    }
  }

  async function joinGame() {
    if (mutationRef.current) return;
    let invite: ReturnType<typeof decodeInvite>;
    try {
      invite = decodeInvite(inviteInput);
      if (hostPrincipal === invite.hostPrincipal) {
        throw new Error("Open the host game tile instead of joining your own Neutron");
      }
    } catch (reason) {
      setError(errorMessage(reason));
      return;
    }
    const mutation = {};
    mutationRef.current = mutation;
    const epoch = ++sessionEpochRef.current;
    const previousGameId = gameRef.current?.gameId ?? null;
    setBusy("joining");
    setError(null);
    setSessionRecoveryError(null);
    setSelected(null);
    setPendingPromotion(null);
    try {
      const raw = await requestBackendCallReservations(
        remoteJoinRequest(tileId, invite),
      );
      if (!isJsonObject(raw)) throw new Error("Invalid backend access response");
      if (typeof raw.callError === "string") {
        throw new Error(`Access was saved, but the game could not be joined: ${raw.callError}`);
      }
      if (raw.callResult === undefined) {
        throw new Error("The host did not return a Chess game");
      }
      if (epoch === sessionEpochRef.current) {
        applyGame(parseGame(raw.callResult));
        setInviteInput("");
      }
    } catch (reason) {
      if (epoch === sessionEpochRef.current) {
        await reconcileMutation(epoch, previousGameId, errorMessage(reason));
      }
    } finally {
      finishMutation(mutation, epoch);
    }
  }

  function requestMove(from: string, to: string) {
    if (!game || !canMove || pendingPromotion || from === to) {
      setSelected(null);
      return;
    }
    const choices = (legalByFrom.get(from) ?? []).filter((move) => move.to === to);
    if (choices.length === 0) {
      const piece = pieces.get(to);
      if (piece && pieceColor(piece) === game.turn && legalByFrom.has(to)) {
        setSelected(to);
      } else {
        setSelected(null);
      }
      return;
    }
    if (choices.some((move) => move.promotion !== null)) {
      setPendingPromotion({ from, to, color: game.turn });
      setSelected(null);
      return;
    }
    setSelected(null);
    void submitMove(from, to, null, "local");
  }

  function submitMove(
    from: string,
    to: string,
    promotion: PromotionPiece | null,
    actor: "local" | "computer",
  ) {
    if (!game) return;
    void runUpdate(
      "chess_move",
      {
        tile_id: tileId,
        from,
        to,
        ...(promotion ? { promotion } : {}),
        expected_revision: String(game.revision),
      },
      actor === "computer" ? "computer" : "move",
    );
  }

  function handleSquareClick(square: string, piece: PieceCode | undefined) {
    if (ignoreClickRef.current || !game || !canMove || pendingPromotion) return;
    if (!selected) {
      if (
        piece &&
        pieceColor(piece) === game.turn &&
        legalByFrom.has(square)
      ) {
        setSelected(square);
      }
      return;
    }
    if (selected === square) {
      setSelected(null);
      return;
    }
    requestMove(selected, square);
  }

  function handleDragStart(event: DragEvent<HTMLButtonElement>, square: string) {
    const piece = pieces.get(square);
    if (
      !game ||
      !canMove ||
      pendingPromotion ||
      !piece ||
      pieceColor(piece) !== game.turn ||
      !legalByFrom.has(square)
    ) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_MIME, square);
    setPieceDragImage(
      event.dataTransfer,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    setDragging(square);
    setSelected(square);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>, square: string) {
    event.preventDefault();
    if (pendingPromotion) return;
    const from = event.dataTransfer.getData(DRAG_MIME);
    setDragging(null);
    setSelected(null);
    if (!/^[a-h][1-8]$/.test(from)) return;
    ignoreClickRef.current = true;
    window.setTimeout(() => {
      ignoreClickRef.current = false;
    }, 0);
    requestMove(from, square);
  }

  function handleBoardKey(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    square: string,
  ) {
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    };
    const offset = offsets[event.key];
    if (!offset) return;
    const fileIndex = displayFiles.indexOf(square.charAt(0) as (typeof CHESS_FILES)[number]);
    const rankIndex = displayRanks.indexOf(Number(square.charAt(1)));
    const nextRank = rankIndex + offset[0];
    const nextFile = fileIndex + offset[1];
    if (
      fileIndex < 0 ||
      rankIndex < 0 ||
      nextRank < 0 ||
      nextRank >= displayRanks.length ||
      nextFile < 0 ||
      nextFile >= displayFiles.length
    ) {
      return;
    }
    event.preventDefault();
    const nextSquare = `${displayFiles[nextFile]}${displayRanks[nextRank]}`;
    setFocusedSquare(nextSquare);
    window.requestAnimationFrame(() => {
      boardRef.current
        ?.querySelector<HTMLButtonElement>(`[data-square="${nextSquare}"]`)
        ?.focus();
    });
  }

  function requestNewGame() {
    if (!newGameArmed) {
      setNewGameArmed(true);
      return;
    }
    setNewGameArmed(false);
    setSelected(null);
    setPendingPromotion(null);
    openSetup();
  }

  function openSetup() {
    if (mutationRef.current) return;
    sessionEpochRef.current += 1;
    computerRevisionRef.current = null;
    setBusy(null);
    setSetupOpen(true);
  }

  function runAction(action: "resign" | "offer_draw" | "accept_draw" | "decline_draw") {
    if (!game) return;
    void runUpdate(
      "chess_action",
      {
        tile_id: tileId,
        action,
        ...(game.localColor ? { player_color: game.localColor } : {}),
        expected_revision: String(game.revision),
      },
      action,
    );
  }

  async function copyInvite() {
    if (!inviteCode) return;
    try {
      await copyToClipboard(inviteCode);
      setCopied(true);
      window.setTimeout(() => mountedRef.current && setCopied(false), 2_000);
    } catch {
      setError("Copy failed. Select the invite code and copy it manually.");
    }
  }

  if (sessionRecoveryError || (initialLoadFailed && !game)) {
    return (
      <SessionRecovery
        busy={busy !== null}
        message={sessionRecoveryError ?? error ?? "Chess could not load this tile's game"}
        onRetry={() => void recoverTileSession()}
      />
    );
  }

  if (setupOpen || (!game && busy !== "loading")) {
    return (
      <GameSetup
        busy={busy !== null}
        color={colorChoice}
        computerLevel={computerLevel}
        error={error}
        hasGame={Boolean(game)}
        invite={inviteInput}
        onCancel={() => setSetupOpen(false)}
        onColor={setColorChoice}
        onComputerLevel={setComputerLevel}
        onDismissError={() => setError(null)}
        onInvite={setInviteInput}
        onJoin={() => void joinGame()}
        onOpponent={setOpponent}
        onStart={() => void startGame()}
        opponent={opponent}
        onRetryRemoteHost={() => void loadHostPrincipal()}
        remoteHostError={hostPrincipalError}
        remoteHostReady={hostPrincipal !== null}
      />
    );
  }

  if (!game) {
    return (
      <main className="nt-app nt-app--fill chess-app chess-loading">
        <span className="chess-busy is-centered" aria-label="Loading Chess" role="status" />
      </main>
    );
  }

  const opponentDrawOffer =
    game.drawOfferBy !== null &&
    game.localColor !== null &&
    game.drawOfferBy !== game.localColor;
  const showTerminal = isTerminal(game.status);

  return (
    <main className="nt-app nt-app--fill chess-app">
      <div className="chess-shell">
        <header className="chess-toolbar">
          <div className="chess-turn" aria-live="polite">
            <span
              aria-hidden="true"
              className={`chess-turn-piece is-${game.turn}`}
            />
            <span>{statusLabel(game)}</span>
          </div>
          <span className="chess-mode">{modeLabel(game.mode)}</span>
          <span className="chess-revision" title="Game revision">
            #{game.revision}
          </span>
          <div className="chess-actions">
            {game.status === "active" ? (
              <span className="chess-compact-match-actions">
                {game.mode === "remote_host" || game.mode === "remote_guest" ? (
                  <button
                    aria-label="Offer draw"
                    className="nt-icon-button"
                    disabled={busy !== null || game.drawOfferBy !== null}
                    onClick={() => runAction("offer_draw")}
                    title="Offer draw"
                    type="button"
                  >
                    <span aria-hidden="true">½</span>
                  </button>
                ) : null}
                <button
                  aria-label="Resign game"
                  className="nt-icon-button is-danger"
                  disabled={busy !== null}
                  onClick={() => runAction("resign")}
                  title="Resign"
                  type="button"
                >
                  <IoFlagOutline aria-hidden="true" />
                </button>
              </span>
            ) : null}
            <button
              aria-label="Undo last move"
              className="nt-icon-button"
              disabled={
                busy !== null ||
                game.status !== "active" ||
                game.history.length === 0 ||
                game.mode === "remote_host" ||
                game.mode === "remote_guest"
              }
              onClick={() =>
                void runUpdate(
                  "chess_undo",
                  {
                    tile_id: tileId,
                    expected_revision: String(game.revision),
                  },
                  "undo",
                )
              }
              title="Undo"
              type="button"
            >
              <IoArrowUndoOutline aria-hidden="true" />
            </button>
            <button
              aria-label="Flip board"
              className="nt-icon-button"
              onClick={() => setFlipped((current) => !current)}
              title="Flip board"
              type="button"
            >
              <IoSwapVerticalOutline aria-hidden="true" />
            </button>
            <button
              aria-label={newGameArmed ? "Confirm new game" : "Start a new game"}
              className={`nt-icon-button chess-reset${newGameArmed ? " is-armed" : ""}`}
              disabled={busy !== null}
              onClick={requestNewGame}
              title={newGameArmed ? "Confirm new game" : "New game"}
              type="button"
            >
              {newGameArmed ? (
                <IoCheckmark aria-hidden="true" />
              ) : (
                <IoRefreshOutline aria-hidden="true" />
              )}
            </button>
          </div>
        </header>

        <div className="chess-main">
          <section className="chess-board-stage" aria-label="Chess board">
            <div
              aria-busy={busy !== null}
              className={`chess-board${dragging ? " is-dragging" : ""}`}
              ref={boardRef}
              role="grid"
            >
              {displayRanks.flatMap((rank, rowIndex) =>
                displayFiles.map((file, columnIndex) => {
                  const square = `${file}${rank}`;
                  const piece = pieces.get(square);
                  const canonicalFile = CHESS_FILES.indexOf(file);
                  const dark = (canonicalFile + rank) % 2 === 1;
                  const isLast = lastMove?.from === square || lastMove?.to === square;
                  const legalMove = selectedMoves.find((move) => move.to === square);
                  const isCapture = Boolean(
                    legalMove &&
                      (pieces.has(square) ||
                        (pieceKind(pieces.get(selected ?? "") ?? "wP") === "P" &&
                          game.enPassant === square)),
                  );
                  return (
                    <button
                      aria-label={squareLabel(square, piece, Boolean(legalMove))}
                      aria-pressed={selected === square}
                      className={[
                        "chess-square",
                        dark ? "is-dark" : "is-light",
                        selected === square ? "is-selected" : "",
                        isLast ? "is-last-move" : "",
                        legalMove ? (isCapture ? "is-legal-capture" : "is-legal") : "",
                        checkedKing === square ? "is-check" : "",
                        dragging === square ? "is-drag-source" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-square={square}
                      draggable={
                        Boolean(piece) &&
                        canMove &&
                        !pendingPromotion &&
                        pieceColor(piece!) === game.turn &&
                        legalByFrom.has(square)
                      }
                      key={square}
                      onClick={() => handleSquareClick(square, piece)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(event) => {
                        if (!canMove || pendingPromotion) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDragStart={(event) => handleDragStart(event, square)}
                      onDrop={(event) => handleDrop(event, square)}
                      onFocus={() => setFocusedSquare(square)}
                      onKeyDown={(event) => handleBoardKey(event, square)}
                      role="gridcell"
                      tabIndex={focusedSquare === square ? 0 : -1}
                      type="button"
                    >
                      {piece ? <ChessPiece piece={piece} /> : null}
                      {columnIndex === 0 ? (
                        <span className="chess-rank" aria-hidden="true">
                          {rank}
                        </span>
                      ) : null}
                      {rowIndex === 7 ? (
                        <span className="chess-file" aria-hidden="true">
                          {file}
                        </span>
                      ) : null}
                    </button>
                  );
                }),
              )}

              {pendingPromotion ? (
                <PromotionDialog
                  pending={pendingPromotion}
                  onCancel={() => setPendingPromotion(null)}
                  onChoose={(promotion) => {
                    const pending = pendingPromotion;
                    setPendingPromotion(null);
                    submitMove(pending.from, pending.to, promotion, "local");
                  }}
                />
              ) : null}

              {game.status === "waiting" && inviteCode ? (
                <div className="chess-board-dialog chess-invite-dialog" role="status">
                  <strong>Waiting for an opponent</strong>
                  <span>Send this invite to a player with Chess installed in Neutron.</span>
                  <textarea
                    aria-label="Chess invite code"
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    rows={3}
                    value={inviteCode}
                  />
                  <button className="nt-button" onClick={() => void copyInvite()} type="button">
                    {copied ? <IoCheckmark aria-hidden="true" /> : <IoCopyOutline aria-hidden="true" />}
                    {copied ? "Copied" : "Copy invite"}
                  </button>
                </div>
              ) : game.status === "waiting" ? (
                <div className="chess-board-dialog chess-invite-dialog" role="alert">
                  <strong>Invite unavailable</strong>
                  <span>
                    {hostPrincipalError
                      ? `Neutron could not load its principal: ${hostPrincipalError}`
                      : "Loading the Neutron principal for this invite…"}
                  </span>
                  {hostPrincipalError ? (
                    <button className="nt-button" onClick={() => void loadHostPrincipal()} type="button">
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}

              {showTerminal ? (
                <div className="chess-board-dialog chess-result-dialog" role="status">
                  <strong>{resultTitle(game)}</strong>
                  <span>{resultDetail(game)}</span>
                  <button className="nt-button" disabled={busy !== null} onClick={openSetup} type="button">
                    New game
                  </button>
                </div>
              ) : null}

              {opponentDrawOffer && game.status === "active" ? (
                <DrawOfferDialog
                  busy={busy !== null}
                  onAccept={() => runAction("accept_draw")}
                  onDecline={() => runAction("decline_draw")}
                />
              ) : null}
            </div>
          </section>

          <aside className="chess-sidebar" aria-label="Game details">
            <section className="chess-game-meta">
              <span>
                <small>You play</small>
                <strong>{game.localColor ? capitalize(game.localColor) : "Both sides"}</strong>
              </span>
              <span>
                <small>Game</small>
                <strong>{shortGameId(game.gameId)}</strong>
              </span>
            </section>
            <section className="chess-history" aria-label="Move history">
              <div className="chess-history-heading">
                <span>Moves</span>
                <span>{game.history.length}</span>
              </div>
              <div className="chess-moves" ref={historyRef}>
                {game.history.length === 0 ? (
                  <span className="chess-no-moves" aria-label="No moves">-</span>
                ) : (
                  game.history.map((move) => (
                    <MoveRow key={`${move.ply}-${move.at}`} move={move} />
                  ))
                )}
              </div>
            </section>
            {game.status === "active" ? (
              <section className="chess-match-actions">
                {game.mode === "remote_host" || game.mode === "remote_guest" ? (
                  <button
                    className="nt-button nt-button--quiet"
                    disabled={busy !== null || game.drawOfferBy !== null}
                    onClick={() => runAction("offer_draw")}
                    type="button"
                  >
                    Offer draw
                  </button>
                ) : null}
                <button
                  className="nt-button nt-button--danger"
                  disabled={busy !== null}
                  onClick={() => runAction("resign")}
                  type="button"
                >
                  <IoFlagOutline aria-hidden="true" />
                  Resign
                </button>
              </section>
            ) : null}
          </aside>
        </div>

        {error ? (
          <div className="chess-error" role="alert" title={error}>
            <IoWarningOutline aria-hidden="true" />
            <span>{error}</span>
            {hostPushAccessRetry && game.mode === "remote_host" ? (
              <button
                className="nt-button nt-button--quiet"
                disabled={busy !== null}
                onClick={() => void prepareHostPushAccess(game, true)}
                type="button"
              >
                Retry peer push
              </button>
            ) : null}
            {guestRecoveryNeeded && game.mode === "remote_guest" ? (
              <button
                className="nt-button nt-button--quiet"
                disabled={busy !== null}
                onClick={() => void recoverGuestState(true)}
                type="button"
              >
                Retry sync
              </button>
            ) : null}
            <button
              aria-label="Dismiss error"
              className="nt-icon-button"
              onClick={() => setError(null)}
              type="button"
            >
              <IoClose aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {busy ? (
          <span className="chess-busy" aria-label={busyLabel(busy)} role="status" />
        ) : null}
      </div>
    </main>
  );
}

function GameSetup({
  busy,
  color,
  computerLevel,
  error,
  hasGame,
  invite,
  onCancel,
  onColor,
  onComputerLevel,
  onDismissError,
  onInvite,
  onJoin,
  onOpponent,
  onRetryRemoteHost,
  onStart,
  opponent,
  remoteHostError,
  remoteHostReady,
}: {
  busy: boolean;
  color: ColorChoice;
  computerLevel: ComputerLevel;
  error: string | null;
  hasGame: boolean;
  invite: string;
  onCancel: () => void;
  onColor: (value: ColorChoice) => void;
  onComputerLevel: (value: ComputerLevel) => void;
  onDismissError: () => void;
  onInvite: (value: string) => void;
  onJoin: () => void;
  onOpponent: (value: SetupOpponent) => void;
  onRetryRemoteHost: () => void;
  onStart: () => void;
  opponent: SetupOpponent;
  remoteHostError: string | null;
  remoteHostReady: boolean;
}) {
  return (
    <main className="nt-app nt-app--fill chess-app chess-setup-shell">
      <section className="chess-setup" aria-label="New Chess game">
        <header>
          <span className="chess-setup-mark" aria-hidden="true">♞</span>
          <span>
            <h1>New game</h1>
            <p>Choose who will play the other side.</p>
          </span>
        </header>

        <div className="chess-opponents" role="radiogroup" aria-label="Opponent">
          {(["computer", "local", "remote"] as const).map((value) => (
            <button
              aria-checked={opponent === value}
              className={opponent === value ? "is-selected" : ""}
              key={value}
              onClick={() => onOpponent(value)}
              role="radio"
              type="button"
            >
              <strong>{opponentLabel(value)}</strong>
              <small>{opponentDetail(value)}</small>
            </button>
          ))}
        </div>

        {opponent !== "local" ? (
          <fieldset className="chess-choice-row">
            <legend>Your color</legend>
            {(["white", "black", "random"] as const).map((value) => (
              <label key={value}>
                <input
                  checked={color === value}
                  name="chess-color"
                  onChange={() => onColor(value)}
                  type="radio"
                />
                <span>{capitalize(value)}</span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {opponent === "computer" ? (
          <fieldset className="chess-choice-row">
            <legend>Computer strength</legend>
            {(["easy", "medium", "hard"] as const).map((value) => (
              <label key={value}>
                <input
                  checked={computerLevel === value}
                  name="chess-level"
                  onChange={() => onComputerLevel(value)}
                  type="radio"
                />
                <span>{capitalize(value)}</span>
              </label>
            ))}
          </fieldset>
        ) : null}

        <div className="chess-setup-primary">
          <button
            className="nt-button"
            disabled={busy || (opponent === "remote" && !remoteHostReady)}
            onClick={onStart}
            type="button"
          >
            {busy
              ? "Starting…"
              : opponent === "remote" && !remoteHostReady
                ? remoteHostError
                  ? "Invite unavailable"
                  : "Loading identity…"
                : opponent === "remote"
                  ? "Create invite"
                  : "Start game"}
          </button>
          {hasGame ? (
            <button className="nt-button nt-button--quiet" disabled={busy} onClick={onCancel} type="button">
              Cancel
            </button>
          ) : null}
        </div>
        {opponent === "remote" && remoteHostError ? (
          <div className="chess-host-error" role="alert">
            <span>Neutron could not load the host principal: {remoteHostError}</span>
            <button className="nt-button nt-button--quiet" disabled={busy} onClick={onRetryRemoteHost} type="button">
              Retry
            </button>
          </div>
        ) : null}

        <div className="chess-join-separator"><span>Have an invite?</span></div>
        <label className="chess-invite-input">
          <span>Paste a Neutron Chess invite code</span>
          <textarea
            maxLength={MAX_INVITE_CODE_LENGTH}
            onChange={(event) => onInvite(event.currentTarget.value)}
            placeholder="NC1-…"
            rows={3}
            value={invite}
          />
        </label>
        <button
          className="nt-button nt-button--quiet chess-join-button"
          disabled={busy || invite.trim().length === 0}
          onClick={onJoin}
          type="button"
        >
          Join remote game
        </button>

        {error ? (
          <div className="chess-setup-error" role="alert">
            <IoWarningOutline aria-hidden="true" />
            <span>{error}</span>
            <button className="nt-icon-button" aria-label="Dismiss error" onClick={onDismissError} type="button">
              <IoClose aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function SessionRecovery({
  busy,
  message,
  onRetry,
}: {
  busy: boolean;
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="nt-app nt-app--fill chess-app chess-setup-shell">
      <section className="chess-recovery" role="alert">
        <IoWarningOutline aria-hidden="true" />
        <h1>Game state unavailable</h1>
        <p>{message}</p>
        <button className="nt-button" disabled={busy} onClick={onRetry} type="button">
          {busy ? "Checking…" : "Retry safely"}
        </button>
      </section>
    </main>
  );
}

function DrawOfferDialog({
  busy,
  onAccept,
  onDecline,
}: {
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const controls = () => [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    controls()[0]?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const buttons = controls();
      if (buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey
        ? current <= 0 ? buttons.length - 1 : current - 1
        : current < 0 || current === buttons.length - 1 ? 0 : current + 1;
      event.preventDefault();
      buttons[next]?.focus();
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <div
      aria-label="Draw offer"
      aria-modal="true"
      className="chess-board-dialog chess-draw-dialog"
      ref={dialogRef}
      role="dialog"
    >
      <strong>Your opponent offers a draw</strong>
      <span className="chess-dialog-actions">
        <button className="nt-button" disabled={busy} onClick={onAccept} type="button">
          Accept
        </button>
        <button className="nt-button nt-button--quiet" disabled={busy} onClick={onDecline} type="button">
          Decline
        </button>
      </span>
    </div>
  );
}

function PromotionDialog({
  pending,
  onCancel,
  onChoose,
}: {
  pending: PendingPromotion;
  onCancel: () => void;
  onChoose: (promotion: PromotionPiece) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const controls = () => [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    controls()[0]?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = controls();
      if (buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey
        ? current <= 0 ? buttons.length - 1 : current - 1
        : current < 0 || current === buttons.length - 1 ? 0 : current + 1;
      event.preventDefault();
      buttons[next]?.focus();
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <div
      aria-label="Choose promotion piece"
      aria-modal="true"
      className="chess-promotion"
      ref={dialogRef}
      role="dialog"
    >
      {PROMOTION_CHOICES.map((promotion) => {
        const piece = `${pending.color === "white" ? "w" : "b"}${promotion.toUpperCase()}` as PieceCode;
        return (
          <button
            aria-label={`Promote to ${PIECE_NAMES[pieceKind(piece)]}`}
            className="chess-promotion-choice"
            key={promotion}
            onClick={() => onChoose(promotion)}
            type="button"
          >
            <ChessPiece piece={piece} />
          </button>
        );
      })}
      <button
        aria-label="Cancel promotion"
        className="nt-icon-button chess-promotion-cancel"
        onClick={onCancel}
        title="Cancel"
        type="button"
      >
        <IoClose aria-hidden="true" />
      </button>
    </div>
  );
}

function ChessPiece({ piece }: { piece: PieceCode }) {
  const PieceIcon = PIECE_ICONS[pieceKind(piece)];
  return (
    <PieceIcon
      aria-hidden="true"
      className={`chess-piece is-${piece[0] === "w" ? "white" : "black"}`}
      focusable="false"
    />
  );
}

function MoveRow({ move }: { move: ChessMove }) {
  return (
    <div className="chess-move">
      <span>{move.ply}</span>
      <strong title={`${move.from} to ${move.to}`}>{move.notation}</strong>
    </div>
  );
}

function piecesFromRows(rows: string[]): Map<string, PieceCode> {
  const pieces = new Map<string, PieceCode>();
  rows.forEach((row, rowIndex) => {
    [...row].forEach((symbol, fileIndex) => {
      if (symbol === ".") return;
      const upper = symbol.toUpperCase() as PieceCode[1];
      pieces.set(
        `${CHESS_FILES[fileIndex]}${8 - rowIndex}`,
        `${symbol === upper ? "w" : "b"}${upper}` as PieceCode,
      );
    });
  });
  return pieces;
}

function groupLegalMoves(moves: ChessLegalMove[]): Map<string, ChessLegalMove[]> {
  const grouped = new Map<string, ChessLegalMove[]>();
  for (const move of moves) {
    const current = grouped.get(move.from) ?? [];
    current.push(move);
    grouped.set(move.from, current);
  }
  return grouped;
}

function findKing(pieces: Map<string, PieceCode>, color: ChessColor): string | null {
  const king = `${color === "white" ? "w" : "b"}K`;
  for (const [square, piece] of pieces) if (piece === king) return square;
  return null;
}

function canLocalMove(game: ChessGame): boolean {
  if (game.status !== "active") return false;
  if (game.mode === "local") return true;
  return game.localColor === game.turn;
}

function chooseColor(choice: ColorChoice): ChessColor {
  if (choice !== "random") return choice;
  const random = new Uint8Array(1);
  crypto.getRandomValues(random);
  return (random[0] ?? 0) % 2 === 0 ? "white" : "black";
}

function pieceColor(piece: PieceCode): ChessColor {
  return piece[0] === "w" ? "white" : "black";
}

function pieceKind(piece: PieceCode): PieceKind {
  return piece.charAt(1) as PieceKind;
}

function squareLabel(
  square: string,
  piece: PieceCode | undefined,
  legal: boolean,
): string {
  const suffix = legal ? ", legal destination" : "";
  if (!piece) return `${square}, empty${suffix}`;
  return `${square}, ${pieceColor(piece)} ${PIECE_NAMES[pieceKind(piece)]}${suffix}`;
}

function statusLabel(game: ChessGame): string {
  if (game.status === "waiting") return "Waiting for opponent";
  if (game.status === "active") {
    return `${capitalize(game.turn)} to move${game.inCheck ? " — check" : ""}`;
  }
  return resultTitle(game);
}

function resultTitle(game: ChessGame): string {
  if (game.status === "checkmate") return `${capitalize(game.winner ?? game.turn)} wins`;
  if (game.status === "resigned") return `${capitalize(game.winner ?? game.turn)} wins`;
  return "Draw";
}

function resultDetail(game: ChessGame): string {
  switch (game.status) {
    case "checkmate":
      return "Checkmate";
    case "stalemate":
      return "Stalemate";
    case "draw_fifty_move":
      return "Fifty-move rule";
    case "draw_threefold":
      return "Threefold repetition";
    case "draw_insufficient_material":
      return "Insufficient material";
    case "draw_agreement":
      return "Draw by agreement";
    case "resigned":
      if (!game.localColor) {
        return game.winner
          ? `${game.winner === "white" ? "Black" : "White"} resigned`
          : "A player resigned";
      }
      return game.winner === game.localColor ? "Opponent resigned" : "You resigned";
    default:
      return "Game complete";
  }
}

function isTerminal(status: ChessGame["status"]): boolean {
  return status !== "active" && status !== "waiting";
}

function modeLabel(mode: ChessMode): string {
  switch (mode) {
    case "local":
      return "Local";
    case "computer":
      return "Computer";
    case "remote_host":
      return "Remote host";
    case "remote_guest":
      return "Remote guest";
  }
}

function opponentLabel(opponent: SetupOpponent): string {
  if (opponent === "computer") return "Computer";
  if (opponent === "local") return "Local players";
  return "Remote player";
}

function opponentDetail(opponent: SetupOpponent): string {
  if (opponent === "computer") return "Browser-powered opponent";
  if (opponent === "local") return "Move for both colors";
  return "Create and send an invite";
}

function shortGameId(gameId: string): string {
  return gameId.length > 10 ? `${gameId.slice(0, 6)}…${gameId.slice(-4)}` : gameId;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function busyLabel(value: string): string {
  if (value === "computer") return "Computer is thinking";
  if (value === "joining") return "Joining remote game";
  if (value === "creating") return "Creating game";
  return "Synchronizing game";
}

function errorMessage(error: unknown): string {
  const normalized = toError(error);
  return normalized.message || "Chess request failed";
}

function remoteCommandOutcomeUncertain(code: string | undefined): boolean {
  return (
    code === "call_rejected" ||
    code === "reply_limit" ||
    code === "internal" ||
    code === "remote_ingress" ||
    code === "remote_decode"
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing Chess root element");
createRoot(root).render(<App />);

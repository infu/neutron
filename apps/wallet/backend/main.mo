import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import Catalog "./Catalog";
import AllowanceAccount "./allowances/Account";
import IcpAllowances "./allowances/IcpLegacy";
import Icrc103 "./allowances/Icrc103";
import Capabilities "./capabilities/Types";
import ChainKey "./chainkey/Client";
import Withdrawals "./chainkey/Withdrawals";
import History "./history/Reconcile";
import HistoryStore "./history/Store";
import HistoryTypes "./history/Types";
import Icrc "./icrc1/Client";
import IcrcTypes "./icrc1/Types";
import FundingDisplay "./funding/Display";
import FundingJournal "./funding/Journal";
import Memory "./memory/wallet/v1";
import CommandMemory "./memory/wallet_commands/v1";
import TransferMemory "./memory/wallet_transfers/v1";
import TransferJournal "./transfers/Journal";
import TransferSettlement "./transfers/Settlement";
import TransferRefund "./transfers/Refund";
import BridgeMemory "./memory/wallet_bridge/v1";
import BridgeReplacementMemory "./memory/wallet_bridge_replacements/v1";
import Bridge "./bridge/Journal";
import BridgeProviderMemory "./memory/wallet_bridge_provider/v1";
import BridgeProvider "./bridge/BridgeProvider";
import BridgeActivityMemory "./memory/wallet_bridge_activity/v1";
import BridgeActivity "./bridge/Activity";
import RefillMemory "./memory/wallet_refills/v1";
import Refill "./refill/Service";

module {
    let BATCH_SIZE = 20;
    let DEPOSIT_PROGRESS_LIMIT = 64;
    let MAX_RETAINED_CUSTOM_LEDGERS = 64;
    let MAX_SELECTED_LEDGERS = 16;
    let RECENT_MINTED_LIMIT = 20;
    let COMMAND_CAPACITY = 256;
    let COMMAND_PRUNE_LIMIT = 64;
    let MAX_PREPARED_COMMANDS_PER_APP = 8;
    let REQUEST_ID_BYTES = 16;
    let MAX_FUNDING_INTENT_BYTES = 4_096;
    let MAX_FUNDING_CALL_ARGS_BYTES = 4_096;
    let MAX_FUNDING_MEMO_BYTES = 32;
    let MAX_FUNDING_VALIDITY_NS : Nat64 = 600_000_000_000;
    let MAX_ALLOWANCE_LIFETIME_NS : Nat64 = 600_000_000_000;
    let COMMAND_RETENTION_NS : Int = 86_400_000_000_000;
    let MAX_ALLOWANCE_PAGE_SIZE = 100;

    // Public Candid DTOs stay visible to the application's method-schema
    // generator. Service and immutable memory types are structurally identical.
    public type WalletRefillKindV1 = { #icp_topup; #tcycles_topup; #icp_to_tcycles };
    public type WalletRefillPhaseV1 = {
        #prepared; #transfer_pending; #notify_pending; #withdraw_pending;
        #forward_pending; #complete; #refunded; #stopped;
    };
    public type WalletRefillRequestV1 = {
        id : Blob; kind : WalletRefillKindV1; target : Principal; amount : Nat;
        icp_fee : Nat; cycles_fee : Nat; estimated_cycles : Nat;
    };
    public type WalletRefillViewV1 = {
        id : Blob; kind : WalletRefillKindV1; target : Principal; amount : Nat;
        icp_fee : Nat; cycles_fee : Nat; estimated_cycles : Nat;
        created_at : Int; updated_at : Int; phase : WalletRefillPhaseV1;
        source_block : ?Nat; mint_block : ?Nat; minted_cycles : ?Nat;
        forward_block : ?Nat; refund_block : ?Nat; credited_cycles : ?Nat;
        duplicate : Bool; error : ?Text; can_continue : Bool;
    };
    public type WalletRefillResultV1 = { #ok : WalletRefillViewV1; #err : Text };
    public type WalletRefillCursorV1 = { created_at : Int; id : Blob };
    public type WalletRefillPageRequestV1 = { before : ?WalletRefillCursorV1; limit : Nat; pending_only : Bool };
    public type WalletRefillPageV1 = { operations : [WalletRefillViewV1]; next_cursor : ?WalletRefillCursorV1 };
    public type WalletReadRequestV1 = { #snapshot; #catalog; #refill_status : Blob; #refills : WalletRefillPageRequestV1; #funding_preview : WalletFundingPreviewRequestV1; #token_info_preview : WalletTokenInfoPreviewRequestV1 };
    public type WalletReadResultV1 = {
        #snapshot : WalletSnapshot;
        #catalog : [CatalogLedger];
        #refill_status : WalletRefillResultV1;
        #refills : WalletRefillPageV1;
        #funding_preview : WalletFundingPreviewResultV1;
        #token_info_preview : WalletTokenInfoResultV1;
    };
    public type WalletRefillActionV1 = { #prepare : WalletRefillRequestV1; #execute : Blob; #continue_ : Blob };

    public type CatalogLedger = {
        principal : Principal;
        index : ?Principal;
        history_kind : Text;
        name : Text;
        symbol : Text;
        price_asset : ?Text;
        networks : [Text];
        native_route : ?CatalogNativeRoute;
    };

    public type CatalogNativeRoute = {
        kind : Text;
        origin_network : Text;
        minter : Principal;
        contract : ?Text;
        gas_ledger : ?Principal;
        native_actions_available : Bool;
    };

    public type NativePendingDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
        confirmations : Nat;
        required_confirmations : Nat;
    };

    public type NativeProcessingDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
    };

    public type NativeMintedDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
        minted_amount : Nat;
        block_index : Nat;
        minted_at : Int;
    };

    public type NativeDepositIssueKind = {
        #value_too_small;
        #tainted;
        #quarantined;
    };

    public type NativeDepositIssue = {
        txid : Text;
        vout : Nat;
        value : Nat;
        kind : NativeDepositIssueKind;
        earliest_retry : ?Nat;
    };

    public type NativeDepositProgress = {
        checked_at : Int;
        current_confirmations : ?Nat;
        required_confirmations : ?Nat;
        pending : [NativePendingDeposit];
        processing : [NativeProcessingDeposit];
        recent_minted : [NativeMintedDeposit];
        issues : [NativeDepositIssue];
    };

    public type LedgerView = {
        id : Nat;
        principal : Principal;
        name : ?Text;
        symbol : ?Text;
        decimals : ?Nat;
        fee : ?Nat;
        logo : ?Text;
        balance : ?Nat;
        metadata_updated_at : ?Int;
        balance_updated_at : ?Int;
        metadata_error : ?Text;
        balance_error : ?Text;
        native_address : ?Text;
        native_address_updated_at : ?Int;
        native_address_error : ?Text;
        native_refresh_updated_at : ?Int;
        native_refresh_error : ?Text;
        native_deposit_progress : ?NativeDepositProgress;
    };

    public type WalletSnapshot = {
        owner : Principal;
        configured : Bool;
        ledgers : [LedgerView];
    };

    public type RefreshReport = {
        attempted : Nat;
        succeeded : Nat;
        failed : Nat;
        stale : Nat;
        snapshot : WalletSnapshot;
    };

    public type DepositRefreshReport = {
        attempted : Nat;
        succeeded : Nat;
        failed : Nat;
        stale : Nat;
        snapshot : WalletSnapshot;
    };

    type NativeCall = {
        ledger : Memory.Ledger;
        request : Capabilities.CallRequest;
        route : Catalog.NativeRoute;
    };

    type NativeCounts = {
        attempted : Nat;
        succeeded : Nat;
        failed : Nat;
        stale : Nat;
    };

    public type ContactKindV1 = {
        #person;
        #self;
    };

    public type DestinationKindV1 = {
        #internet_computer;
        #bitcoin_mainnet;
        #dogecoin_mainnet;
        #ethereum_mainnet;
        #solana_mainnet;
    };

    public type DestinationV1 = {
        #internet_computer : {
            owner : Principal;
            subaccount : ?Blob;
        };
        #bitcoin_mainnet : Text;
        #dogecoin_mainnet : Text;
        #ethereum_mainnet : Text;
        #solana_mainnet : Text;
    };

    public type ContactAddressV1 = {
        id : Nat;
        address_label : ?Text;
        destination : DestinationV1;
        preferred : Bool;
    };

    public type ContactErrorV1 = {
        #validation : Text;
        #not_found : Nat;
        #conflict : { expected : Nat; actual : Nat };
        #limit : Text;
    };

    public type DiscoverContactsRequestV1 = {
        contact_id : ?Nat;
        search_text : Text;
        destination_kinds : [DestinationKindV1];
        offset : Nat;
        limit : Nat;
    };

    public type ContactDestinationV1 = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_kind : ContactKindV1;
        contact_name : Text;
        address : ContactAddressV1;
    };

    public type DiscoverContactsPageV1 = {
        book_revision : Nat;
        destinations : [ContactDestinationV1];
        total : Nat;
        next_offset : ?Nat;
    };

    public type DiscoverContactsResultV1 = {
        #ok : DiscoverContactsPageV1;
        #err : ContactErrorV1;
    };

    public type AppCalls = {
        contacts : {
            contacts_discover_v1 : DiscoverContactsRequestV1 -> DiscoverContactsResultV1;
        };
    };

    public type WalletContactDestinationsRequest = {
        ledger : Principal;
        network : DestinationKindV1;
        search_text : Text;
        offset : Nat;
        limit : Nat;
    };

    public type WalletContactRoute = {
        #icrc;
        #native;
    };

    public type WalletContactDestination = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_kind : ContactKindV1;
        contact_name : Text;
        address : ContactAddressV1;
        route : WalletContactRoute;
    };

    public type WalletContactDestinationsPage = {
        ledger : Principal;
        book_revision : Nat;
        destinations : [WalletContactDestination];
        total : Nat;
        next_offset : ?Nat;
    };

    public type WalletContactDestinationsResult = {
        #ok : WalletContactDestinationsPage;
        #err : Text;
    };

    public type WalletTransferRequest = {
        ledger : Principal;
        network : DestinationKindV1;
        contact_id : Nat;
        contact_revision : Nat;
        address_id : Nat;
        expected_destination : DestinationV1;
        amount : Nat;
    };

    public type WalletTransferReceipt = {
        ledger : Principal;
        native : Bool;
        contact_id : Nat;
        address_id : Nat;
        amount : Nat;
        fee : Nat;
        block_index : Nat;
        secondary_block_index : ?Nat;
        duplicate : Bool;
    };

    public type WalletTransferResult = {
        #ok : WalletTransferReceipt;
        #err : Text;
    };

    public type WalletWithdrawalGasAuthorizationV1 = { ledger : Principal; minter : Principal; budget : Nat; ledger_fee : Nat };
    public type WalletWithdrawalAuthorizationV1 = { asset_fee : Nat; gas : ?WalletWithdrawalGasAuthorizationV1 };
    public type WalletWithdrawalQuoteRequestV1 = { ledger : Principal; amount : ?Nat };
    public type WalletWithdrawalGasQuoteV1 = {
        ledger : Principal; budget : Nat; ledger_fee : Nat; allowance : Nat;
        total_debit : Nat; balance : Nat; sufficient : Bool;
    };
    public type WalletWithdrawalQuoteV1 = {
        ledger : Principal; minter : Principal; observed_at_ns : Nat64; amount : ?Nat;
        asset_fee : Nat; asset_allowance : ?Nat; asset_total_debit : ?Nat;
        asset_balance : Nat; asset_sufficient : ?Bool; gas : ?WalletWithdrawalGasQuoteV1;
        authorization : WalletWithdrawalAuthorizationV1;
    };
    public type WalletWithdrawalQuoteResultV1 = { #ok : WalletWithdrawalQuoteV1; #err : Text };

    public type WalletTransferRequestV2 = {
        request_id : Blob;
        transfer : WalletTransferRequest;
        withdrawal_quote : ?WalletWithdrawalAuthorizationV1;
    };
    public type WalletEthereumWithdrawRequestV1 = {
        request_id : Blob;
        ledger : Principal;
        address : Text;
        amount : Nat;
        withdrawal_quote : ?WalletWithdrawalAuthorizationV1;
    };
    public type WalletEthereumWithdrawStatusV1 = {
        request : WalletEthereumWithdrawRequestV1;
        operation : WalletTransferOperationV2;
    };
    public type WalletEthereumWithdrawStatusResultV1 = { #ok : ?WalletEthereumWithdrawStatusV1; #err : Text };
    public type WalletTransferSettlementV2 = {
        checked_at : Int;
        status : {
            #pending : Text;
            #submitted : { transaction_hash : Text; message : Text };
            #confirmed : { transaction_hash : Text };
            #failed : Text;
            #unknown : Text;
        };
    };
    public type WalletTransferOperationV2 = {
        request_id : Blob;
        ledger : Principal;
        amount : Nat;
        native : Bool;
        destination : Text;
        created_at_ns : Nat64;
        message : ?Text;
        settlement : ?WalletTransferSettlementV2;
        status : { #pending; #succeeded : WalletTransferReceipt; #rejected : Text };
    };
    public type WalletTransferResultV2 = { #ok : WalletTransferOperationV2; #err : Text };

    public type WalletBridgeSourceV1 = {
        #external;
        #evm;
        #evm_agent : { app_id : Text; installation_uid : Text };
    };
    public type WalletBridgeStepKindV1 = { #reset_approval; #approval; #deposit };
    public type WalletBridgeStepStateV1 = { #ready; #unknown; #submitted; #confirmed; #failed };
    public type WalletBridgeQuoteV1 = {
        chain_id : Nat;
        ledger : Principal;
        minter : Principal;
        helper_address : Text;
        helper_mode : { #subaccount; #legacy };
        minter_address : Text;
        token_address : ?Text;
        recipient : Principal;
        principal_word : Text;
        subaccount_word : Text;
    };
    public type WalletBridgeStepV1 = {
        kind : WalletBridgeStepKindV1;
        state : WalletBridgeStepStateV1;
        operation_id : ?Text;
        transaction_hash : ?Text;
        error : ?Text;
    };
    public type WalletBridgeAcceptedDepositV1 = { log_index : Nat; block_number : Nat; event_index : Nat64 };
    public type WalletBridgeMintV1 = { ledger_block_index : Nat; event_index : Nat64; verified_ledger : Bool };
    public type WalletBridgeIntentV1 = {
        id : Blob;
        quote : WalletBridgeQuoteV1;
        source : WalletBridgeSourceV1;
        account : Text;
        amount : Nat;
        subaccount : ?Blob;
        steps : [WalletBridgeStepV1];
        revision : Nat;
        created_at : Int;
        updated_at : Int;
        event_cursor : Nat64;
        accepted_deposit : ?WalletBridgeAcceptedDepositV1;
        mint : ?WalletBridgeMintV1;
        error : ?Text;
    };
    public type WalletBridgeProviderBindingV1 = {
        app_id : Text; installation_uid : Text; agent_mode : Bool;
        key_fingerprint : Text; namespace_version : Text;
    };
    public type WalletBridgeProviderPrepareRequestV1 = {
        bridge : WalletBridgePrepareRequestV1;
        binding : WalletBridgeProviderBindingV1;
    };
    public type WalletBridgeProviderBindingResultV1 = { binding : ?WalletBridgeProviderBindingV1 };
    public type WalletBridgePrepareRequestV1 = {
        id : Blob;
        ledger : Principal;
        source : WalletBridgeSourceV1;
        account : Text;
        amount : Nat;
        subaccount : ?Blob;
    };
    public type WalletBridgeClaimRequestV1 = {
        id : Blob;
        revision : Nat;
        step : WalletBridgeStepKindV1;
        operation_id : ?Text;
    };
    public type WalletBridgeRecordStepRequestV1 = {
        id : Blob;
        revision : Nat;
        step : WalletBridgeStepKindV1;
        state : { #submitted; #confirmed; #failed; #unknown };
        transaction_hash : ?Text;
        error : ?Text;
    };
    public type WalletBridgeReplacementRequestV1 = {
        id : Blob; revision : Nat; step : WalletBridgeStepKindV1;
        original_transaction_hash : Text; previous_transaction_hash : Text; transaction_hash : Text;
        state : { #submitted; #confirmed; #failed }; error : ?Text;
    };
    public type WalletBridgeEffectiveHashRequestV1 = { id : Blob; step : WalletBridgeStepKindV1 };
    public type WalletBridgeReplacementActionV1 = {
        #lookup : WalletBridgeEffectiveHashRequestV1;
        #record : WalletBridgeReplacementRequestV1;
    };
    public type WalletBridgeReplacementValueV1 = { #hash : ?Text; #intent : WalletBridgeIntentV1 };
    public type WalletBridgeReplacementResultV1 = { #ok : WalletBridgeReplacementValueV1; #err : Text };
    public type WalletBridgeRefreshRequestV1 = { id : Blob; event_page_length : Nat64 };
    public type WalletBridgeListRequestV1 = { ledger : ?Principal; after : ?Blob; limit : Nat };
    public type WalletBridgePageV1 = { records : [WalletBridgeIntentV1]; next : ?Blob };
    public type WalletBridgeQuoteResultV1 = { #ok : WalletBridgeQuoteV1; #err : Text };
    public type WalletBridgeIntentResultV1 = { #ok : WalletBridgeIntentV1; #err : Text };
    public type WalletBridgeActivityRequestV1 = { ledger : ?Principal };
    public type WalletBridgeActivityEntryV1 = { id : Blob; dismissed_at : Int };
    public type WalletBridgeActivityResultV1 = { records : [WalletBridgeActivityEntryV1] };
    public type WalletBridgeDismissRequestV1 = { id : Blob; dismissed : Bool };
    public type WalletBridgeStepActionV2 = {
        #claim : WalletBridgeClaimRequestV1;
        #record : WalletBridgeRecordStepRequestV1;
        #dismiss : WalletBridgeDismissRequestV1;
    };

    public type WalletFundingCallerV1 = {
        endpoint : Text;
        app_id : Text;
        role : ?Text;
    };

    public type WalletFundingSourceV1 = {
        #icrc;
        #icp;
    };

    public type WalletIcrcAccountV1 = {
        owner : Principal;
        subaccount : ?Blob;
    };

    public type WalletTokenInfoRequestV1 = {
        ledger : Principal;
    };

    public type WalletTokenInfoV1 = {
        ledger : Principal;
        account : WalletIcrcAccountV1;
        token_name : ?Text;
        token_symbol : Text;
        decimals : Nat;
        fee_atoms : Nat;
        balance_atoms : Nat;
        observed_at_ns : Nat64;
    };

    public type WalletTokenInfoResultV1 = {
        #ok : WalletTokenInfoV1;
        #err : Text;
    };

    public type WalletApprovalSpenderV1 = {
        #icrc : WalletIcrcAccountV1;
        #icp_account_identifier : Blob;
    };

    public type WalletFundingIntentV1 = {
        #direct : {
            amount_atoms : Nat;
            to : WalletIcrcAccountV1;
            memo : ?Blob;
        };
        #allowance : {
            amount_atoms : Nat;
            spender : WalletIcrcAccountV1;
            expires_at_ns : Nat64;
        };
        #revoke : {
            source : WalletFundingSourceV1;
            spender : WalletApprovalSpenderV1;
            expected_allowance_atoms : Nat;
            expected_expires_at_ns : ?Nat64;
        };
    };

    public type WalletFundingPrepareRequestV1 = {
        request_id : Blob;
        ledger : Principal;
        valid_until_ns : Nat64;
        caller : WalletFundingCallerV1;
        agent_mode : Bool;
        intent : WalletFundingIntentV1;
    };

    public type WalletFundingCommandIdV1 = {
        caller_app_id : Text;
        request_id : Blob;
    };

    public type WalletFundingReviewKindV1 = {
        #direct;
        #allowance;
        #revoke;
    };

    public type WalletFundingReviewV1 = {
        command_id : WalletFundingCommandIdV1;
        kind : WalletFundingReviewKindV1;
        ledger : Principal;
        token_name : ?Text;
        token_symbol : Text;
        decimals : Nat;
        amount_atoms : Nat;
        transfer_fee_atoms : ?Nat;
        approval_fee_atoms : ?Nat;
        allowance_atoms : ?Nat;
        current_allowance_atoms : ?Nat;
        current_expires_at_ns : ?Nat64;
        total_debit_atoms : Nat;
        destination : ?WalletIcrcAccountV1;
        spender : ?WalletApprovalSpenderV1;
        memo : ?Blob;
        valid_until_ns : Nat64;
        expires_at_ns : ?Nat64;
    };

    public type WalletFundingPreparedV1 = {
        command_id : WalletFundingCommandIdV1;
        review : WalletFundingReviewV1;
    };

    public type WalletFundingTransferredV1 = {
        command_id : WalletFundingCommandIdV1;
        block_index : Nat;
        duplicate : Bool;
    };

    public type WalletFundingApprovalReceiptV1 = {
        command_id : WalletFundingCommandIdV1;
        block_index : ?Nat;
        duplicate : Bool;
    };

    public type WalletFundingExecutionMessageV1 = {
        command_id : WalletFundingCommandIdV1;
        message : Text;
    };

    public type WalletFundingExecutionResultV1 = {
        #transferred : WalletFundingTransferredV1;
        #approved : WalletFundingApprovalReceiptV1;
        #revoked : WalletFundingApprovalReceiptV1;
        #pending : WalletFundingExecutionMessageV1;
        #rejected : WalletFundingExecutionMessageV1;
    };

    public type WalletFundingCompletedV1 = {
        review : WalletFundingReviewV1;
        result : WalletFundingExecutionResultV1;
    };

    public type WalletFundingPrepareOutcomeV1 = {
        #prepared : WalletFundingPreparedV1;
        #completed : WalletFundingCompletedV1;
    };

    public type WalletFundingPrepareResultV1 = {
        #ok : WalletFundingPrepareOutcomeV1;
        #err : Text;
    };

    // Browser observations are only a review preview. Execute still prepares
    // the original command with fresh ledger calls before any financial effect.
    public type WalletPreviewMetadataV1 = [(Text, { #Nat : Nat; #Int : Int; #Text : Text; #Blob : Blob })];
    public type WalletPreviewAllowanceV1 = { allowance : Nat; expires_at : ?Nat64 };
    public type WalletFundingPreviewFactsV1 = {
        owner : Principal;
        metadata : WalletPreviewMetadataV1;
        fee : Nat;
        allowance : ?WalletPreviewAllowanceV1;
    };
    public type WalletFundingPreviewRequestV1 = {
        request : WalletFundingPrepareRequestV1;
        facts : ?WalletFundingPreviewFactsV1;
        lookup_only : Bool;
    };
    public type WalletFundingPreviewResultV1 = {
        #ok : { preparation : ?WalletFundingPrepareOutcomeV1; durable : Bool };
        #err : Text;
    };
    public type WalletTokenInfoPreviewRequestV1 = {
        ledger : Principal;
        owner : Principal;
        metadata : WalletPreviewMetadataV1;
        fee : Nat;
        balance : Nat;
    };

    public type WalletFundingExecuteRequestV1 = {
        command_id : WalletFundingCommandIdV1;
    };

    public type WalletAllowanceCursorV1 = {
        #icrc103 : {
            from_account : WalletIcrcAccountV1;
            to_spender : WalletIcrcAccountV1;
            pages : Nat;
            entries : Nat;
        };
        #icp : {
            from_account_id : Blob;
            prev_spender_id : Blob;
            pages : Nat;
            entries : Nat;
        };
    };

    public type WalletAllowancesPageRequestV1 = {
        ledger : Principal;
        cursor : ?WalletAllowanceCursorV1;
        limit : Nat;
    };

    public type WalletAllowanceEntryV1 = {
        spender : WalletApprovalSpenderV1;
        amount_atoms : Nat;
        expires_at_ns : ?Nat64;
    };

    public type WalletAllowanceSourceV1 = {
        #icrc103;
        #icp;
        #none;
    };

    public type WalletAllowancesStateV1 = {
        #ready;
        #unsupported;
        #permission_required;
        #degraded : Text;
    };

    public type WalletAllowancesPageV1 = {
        ledger : Principal;
        token_name : ?Text;
        token_symbol : Text;
        decimals : Nat;
        revoke_fee_atoms : ?Nat;
        source : WalletAllowanceSourceV1;
        state : WalletAllowancesStateV1;
        entries : [WalletAllowanceEntryV1];
        next : ?WalletAllowanceCursorV1;
        has_more : Bool;
        warning : ?Text;
    };

    public type WalletAllowancesPageResultV1 = {
        #ok : WalletAllowancesPageV1;
        #err : Text;
    };

    public type WalletHistoryOperation = {
        #transfer;
        #mint;
        #burn;
        #approve;
        #authorized_mint;
        #authorized_burn;
    };
    public type WalletHistoryAddress = {
        #icrc : { owner : Principal; subaccount : ?Blob };
        #icp_account_identifier : Blob;
    };
    public type WalletTransferIntent = {
        contact_id : Nat;
        address_id : Nat;
        contact_name : Text;
        address_label : ?Text;
        network : Text;
        destination : Text;
        native : Bool;
    };
    public type WalletNativeHistoryContext = {
        network : Text;
        transaction_id : ?Text;
        output_index : ?Nat;
        related_ledger : ?Principal;
        related_block_index : ?Nat;
    };
    public type WalletHistoryVerification = {
        #pending;
        #verified;
        #prebaseline;
        #unverified_scan_limit;
    };
    public type WalletHistoryTransaction = {
        block_index : Nat;
        operation : WalletHistoryOperation;
        timestamp_ns : Nat64;
        amount : Nat;
        fee : ?Nat;
        balance_effect : Int;
        from : ?WalletHistoryAddress;
        to : ?WalletHistoryAddress;
        spender : ?WalletHistoryAddress;
        memo : ?Blob;
        intent : ?WalletTransferIntent;
        native : ?WalletNativeHistoryContext;
        provenance : { #local_pending; #index; #ledger };
        verification : WalletHistoryVerification;
    };
    public type WalletHistoryAdjustmentKind = {
        #opening_balance;
        #unexplained_balance;
        #scan_limit;
        #unsupported_operation;
    };
    public type WalletHistoryAdjustment = {
        id : Nat;
        kind : WalletHistoryAdjustmentKind;
        ledger : Principal;
        timestamp_ns : Nat64;
        balance_effect : Int;
        previous_balance : Nat;
        observed_balance : Nat;
        from_tip_exclusive : Nat;
        to_tip_exclusive : Nat;
        detail : Text;
    };
    public type WalletHistoryOrderKey = {
        timestamp_ns : Nat64;
        ledger : Principal;
        kind_order : Nat8;
        id : Nat;
    };
    public type WalletHistoryCheckpoint = {
        tip_exclusive : Nat;
        balance : Nat;
        checked_at : Int;
    };
    public type WalletHistorySource = {
        #index : Principal;
        #ledger;
        #unavailable;
    };
    public type WalletHistoryState = {
        #idle;
        #syncing;
        #catching_up;
        #waiting_for_index;
        #permission_required;
        #degraded;
    };
    public type WalletHistoryPageRequest = {
        ledger : ?Principal;
        before : ?WalletHistoryOrderKey;
        limit : Nat;
        include_logos : ?Bool;
    };
    public type WalletHistoryRecord = {
        #transaction : {
            ledger : Principal;
            symbol : ?Text;
            decimals : ?Nat;
            logo : ?Text;
            value : WalletHistoryTransaction;
        };
        #adjustment : {
            symbol : ?Text;
            decimals : ?Nat;
            logo : ?Text;
            value : WalletHistoryAdjustment;
        };
    };
    public type WalletHistoryPage = {
        records : [WalletHistoryRecord];
        next : ?WalletHistoryOrderKey;
        inspected : Nat;
        has_more : Bool;
        warning : ?Text;
    };
    public type WalletHistoryLedgerStatus = {
        ledger : Principal;
        symbol : ?Text;
        enabled : Bool;
        source : WalletHistorySource;
        state : WalletHistoryState;
        checkpoint : ?WalletHistoryCheckpoint;
        last_attempt_at : ?Int;
        last_success_at : ?Int;
        last_error : ?Text;
        transaction_count : Nat;
        adjustment_count : Nat;
    };
    public type WalletHistoryStatus = {
        running : Bool;
        ledgers : [WalletHistoryLedgerStatus];
    };
    public type WalletHistorySyncLedgerResult = {
        ledger : Principal;
        status : Text;
        records_added : Nat;
        checkpoint : ?WalletHistoryCheckpoint;
        error : ?Text;
    };
    public type WalletHistorySyncReport = {
        started_at : Int;
        finished_at : Int;
        skipped_overlap : Bool;
        ledgers : [WalletHistorySyncLedgerResult];
    };
    public type WalletHistorySourceStatus = {
        ledger : Principal;
        index : ?Principal;
        ready : Bool;
        missing_methods : [Text];
    };

    type ResolvedTransferDestination = {
        destination : DestinationV1;
        contact_name : Text;
        address_label : ?Text;
    };

    type RefundCursor = { start : Nat64; tail : Nat64; backwards : Bool; latest_evidence : ?Nat64 };

    // The journal stores this payload as opaque Candid, not as a schema field.
    // Released records omit destination_binding and decode to null, retaining
    // their Contacts authorization. Numeric contact IDs never select this mode.
    type TransferDestinationBinding = { #direct_ethereum : Text };
    type SavedTransferContext = {
        contact : ResolvedTransferDestination;
        route : ?Catalog.NativeRoute;
        withdrawal_quote : ?WalletWithdrawalAuthorizationV1;
        destination_binding : ?TransferDestinationBinding;
    };

    type ParsedMetadata = {
        name : ?Text;
        symbol : ?Text;
        decimals : ?Nat;
        fee : ?Nat;
        logo : ?Text;
    };

    type FundingMetadata = {
        name : ?Text;
        symbol : Text;
        decimals : Nat;
        fee : Nat;
    };

    type PreparedFunding = {
        operation : CommandMemory.Operation;
        review : CommandMemory.ReviewFacts;
    };

    type CurrentApproval = {
        amount : Nat;
        expires_at : ?Nat64;
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            wallet : Memory.Mem;
            wallet_commands : CommandMemory.Mem;
            wallet_transfers : TransferMemory.Mem;
            wallet_bridge : BridgeMemory.Mem;
            wallet_bridge_replacements : BridgeReplacementMemory.Mem;
            wallet_bridge_provider : BridgeProviderMemory.Mem;
            wallet_bridge_activity : BridgeActivityMemory.Mem;
            wallet_refills : RefillMemory.Mem;
        };
        app_calls : AppCalls;
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.wallet;
        let commandMem = env.stable_memory.wallet_commands;
        let transferMem = env.stable_memory.wallet_transfers;
        let appCalls = env.app_calls;
        let calls = env.capabilities.backend_calls;
        let history = History.Service(mem, calls);
        let bridge = Bridge.ServiceWithReplacements(env.stable_memory.wallet_bridge, env.stable_memory.wallet_bridge_replacements, calls);
        let bridgeProvider = BridgeProvider.Service(env.stable_memory.wallet_bridge_provider, env.stable_memory.wallet_bridge);
        let bridgeActivity = BridgeActivity.Service(env.stable_memory.wallet_bridge_activity, env.stable_memory.wallet_bridge);
        let refills = Refill.Service(env.stable_memory.wallet_refills, calls);
        var transferInFlight = false;
        let refundCursors = Map.empty<Blob, RefundCursor>();

        public func /*query*/wallet_read_v1(request : WalletReadRequestV1) : WalletReadResultV1 {
            switch (request) {
                case (#snapshot) #snapshot(snapshot());
                case (#catalog) #catalog(wallet_catalog(()));
                case (#refill_status(id)) #refill_status(refills.status(id));
                case (#refills(request)) #refills(refills.page(request));
                case (#funding_preview(value)) #funding_preview(fundingPreview(value));
                case (#token_info_preview(value)) #token_info_preview(tokenInfoPreview(value));
            };
        };
        public func /*update*/wallet_refill_action_v1(request : WalletRefillActionV1) : async* WalletRefillResultV1 {
            switch (request) {
                case (#prepare(value)) refills.prepare(value);
                case (#execute(id)) await* refills.execute(id);
                case (#continue_(id)) await* refills.resume(id);
            };
        };
        public func /*update*/wallet_refill_prepare_v1(request : WalletRefillRequestV1) : WalletRefillResultV1 { refills.prepare(request) };
        public func /*update*/wallet_refill_execute_v1(id : Blob) : async* WalletRefillResultV1 { await* refills.execute(id) };
        public func /*update*/wallet_refill_continue_v1(id : Blob) : async* WalletRefillResultV1 { await* refills.resume(id) };
        public func /*query*/wallet_refill_status_v1(id : Blob) : WalletRefillResultV1 { refills.status(id) };

        public func /*query*/wallet_snapshot(()) : WalletSnapshot {
            snapshot();
        };

        public func /*query*/wallet_catalog(()) : [CatalogLedger] {
            Array.map<Catalog.Ledger, CatalogLedger>(
                Catalog.ledgers,
                func(ledger) {
                    {
                        principal = Principal.fromText(ledger.principal);
                        index = switch (ledger.index) {
                            case null null;
                            case (?value) ?Principal.fromText(value);
                        };
                        history_kind = switch (ledger.history_kind) {
                            case (#icp) "icp";
                            case (#icrc) "icrc";
                        };
                        name = ledger.name;
                        symbol = ledger.symbol;
                        price_asset = switch (ledger.price_asset) {
                            case null null;
                            case (?asset) ?Catalog.priceAssetText(asset);
                        };
                        networks = Array.map<Catalog.Network, Text>(
                            ledger.networks,
                            Catalog.networkText,
                        );
                        native_route = switch (ledger.native_route) {
                            case null null;
                            case (?route) ?catalogRoute(route);
                        };
                    };
                },
            );
        };

        public func /*query*/wallet_history_page(
            request : WalletHistoryPageRequest,
        ) : WalletHistoryPage {
            history.page(request);
        };

        public func /*query*/wallet_history_status(()) : WalletHistoryStatus {
            history.status();
        };

        public func /*query*/wallet_history_sources(()) : [WalletHistorySourceStatus] {
            history.sources();
        };

        public func /*update*/wallet_history_sync(()) : async* WalletHistorySyncReport {
            await* history.sync(true);
        };

        public func /*internal*/wallet_history_tick(
            (),
            /*task_capabilities*/ taskCapabilities : Capabilities.TaskCapabilities,
        ) : async* () {
            await* history.tick(taskCapabilities.backend_calls);
        };

        public func /*query*/wallet_contact_destinations(
            request : WalletContactDestinationsRequest,
        ) : WalletContactDestinationsResult {
            switch (Map.get(mem.ledgers, Principal.compare, request.ledger)) {
                case (?ledger) if (ledger.enabled) {};
                case (_) return #err("Ledger is not selected");
            };
            if (not supportsNetwork(request.ledger, request.network)) {
                return #err("Network is not enabled for this ledger");
            };
            switch (appCalls.contacts.contacts_discover_v1({
                contact_id = null;
                search_text = request.search_text;
                destination_kinds = [request.network];
                offset = request.offset;
                limit = request.limit;
            })) {
                case (#err(error)) #err(contactErrorText(error));
                case (#ok(page)) {
                    #ok({
                        ledger = request.ledger;
                        book_revision = page.book_revision;
                        destinations = Array.map<ContactDestinationV1, WalletContactDestination>(
                            page.destinations,
                            func(destination) {
                                {
                                    contact_id = destination.contact_id;
                                    contact_revision = destination.contact_revision;
                                    contact_kind = destination.contact_kind;
                                    contact_name = destination.contact_name;
                                    address = destination.address;
                                    route = switch (destination.address.destination) {
                                        case (#internet_computer(_)) #icrc;
                                        case (_) #native;
                                    };
                                };
                            },
                        );
                        total = page.total;
                        next_offset = page.next_offset;
                    });
                };
            };
        };

        public func /*update*/wallet_transfer(
            request : WalletTransferRequest,
        ) : async* WalletTransferResult {
            if (request.amount == 0) return #err("Transfer amount must be greater than zero");
            if (transferInFlight) return #err("Another Wallet transfer is in progress");
            let resolved = switch (resolveTransferDestination(request)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let catalogLedger = Catalog.find(request.ledger);
            switch (preflightTransfer(request, catalogLedger)) {
                case (#err(error)) return #err(error);
                case (#ok(())) {};
            };

            if (request.network != #internet_computer) {
                switch (catalogLedger) {
                    case (?catalog) switch (catalog.native_route) {
                        case (?route) {
                            let minter = catalogRoute(route).minter;
                            let ledgers = switch (route) {
                                case (#ckerc20(value)) [request.ledger, Principal.fromText(value.cketh_ledger)];
                                case (_) [request.ledger];
                            };
                            for (ledger in ledgers.vals()) {
                                if (TransferJournal.allowanceReserved(transferMem, ledger, minter, null) or fundingAllowancePending(ledger, minter)) {
                                    return #err("An unresolved operation uses this minter allowance. Resume it before starting another withdrawal.");
                                };
                            };
                        };
                        case null {};
                    };
                    case null {};
                };
            };
            transferInFlight := true;
            let feeResult = Icrc.decodeFee(await* calls.call(Icrc.feeRequest(request.ledger)));
            let result : WalletTransferResult = switch (feeResult) {
                case (#err(error)) #err("Could not read the current ledger fee: " # error);
                case (#ok(fee)) {
                    switch (validateTransferDestination(request, resolved.destination)) {
                        case (#err(error)) #err(error);
                        case (#ok(())) {
                            switch (request.network) {
                                case (#internet_computer) {
                                    await* transferIcrc(request, resolved, fee, calls, nowNanos(), null);
                                };
                                case (_) {
                                    switch (catalogLedger) {
                                        case null #err("Ledger has no native withdrawal route");
                                        case (?catalog) {
                                            switch (catalog.native_route) {
                                                case null #err("Ledger has no native withdrawal route");
                                                case (?route) {
                                                    await* transferNative(
                                                        request,
                                                        resolved,
                                                        route,
                                                        fee,
                                                        calls,
                                                        nowNanos(),
                                                        false,
                                                        null,
                                                        null,
                                                        null,
                                                    );
                                                };
                                            };
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
            transferInFlight := false;
            result;
        };

        func transferIcrc(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            fee : Nat,
            executionCalls : Capabilities.BackendCalls,
            createdAt : Nat64,
            memo : ?Blob,
        ) : async* WalletTransferResult {
            let account = switch (resolved.destination) {
                case (#internet_computer(value)) value;
                case (_) return #err("Contact destination is not an ICRC account");
            };
            let args : IcrcTypes.TransferArg = {
                from_subaccount = null;
                to = account;
                amount = request.amount;
                fee = ?fee;
                memo;
                created_at_time = ?createdAt;
            };
            switch (await* Icrc.executeTransfer(executionCalls, request.ledger, args)) {
                case (#unknown(error)) #err(error);
                case (#rejected(error)) #err(error);
                case (#ok(receipt)) {
                    transferSucceeded(
                        request,
                        resolved,
                        fee,
                        receipt.block_index,
                        false,
                        null,
                        null,
                        memo,
                    );
                    #ok(transferReceipt(
                        request,
                        fee,
                        receipt.block_index,
                        null,
                        false,
                        receipt.duplicate,
                    ));
                };
            };
        };

        func transferNative(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            route : Catalog.NativeRoute,
            fee : Nat,
            executionCalls : Capabilities.BackendCalls,
            createdAt : Nat64,
            minterAlreadyDispatched : Bool,
            memo : ?Blob,
            authorization : ?WalletWithdrawalAuthorizationV1,
            destinationBinding : ?TransferDestinationBinding,
        ) : async* WalletTransferResult {
            let address = switch (nativeAddress(resolved.destination)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let withdrawal = await* Withdrawals.withdrawReviewed(
                route,
                request.ledger,
                address,
                request.amount,
                fee,
                createdAt,
                executionCalls,
                func() { if (minterAlreadyDispatched) #ok(()) else validateSavedTransferDestination(request, resolved.destination, destinationBinding) },
                memo,
                authorization,
            );
            switch (withdrawal) {
                case (#err(error)) #err(error);
                case (#ok(receipt)) {
                    let relatedLedger = switch (receipt.gas_burn) {
                        case null null;
                        case (?gas) ?gas.ledger;
                    };
                    let relatedBlock = switch (receipt.gas_burn) {
                        case null null;
                        case (?gas) ?gas.block_index;
                    };
                    transferSucceeded(
                        request,
                        resolved,
                        fee,
                        receipt.asset_burn.block_index,
                        true,
                        relatedLedger,
                        relatedBlock,
                        null,
                    );
                    switch (receipt.gas_burn) {
                        case null {};
                        case (?gas) recordSecondaryNativeBurn(
                            request,
                            resolved,
                            receipt.asset_burn,
                            gas,
                        );
                    };
                    #ok(transferReceipt(
                        request,
                        fee,
                        receipt.asset_burn.block_index,
                        relatedBlock,
                        true,
                        false,
                    ));
                };
            };
        };

        public func /*update*/wallet_withdrawal_quote_v1(request : WalletWithdrawalQuoteRequestV1) : async* WalletWithdrawalQuoteResultV1 {
            switch (selectedLedger(request.ledger)) { case (#err(error)) return #err(error); case (_) {} };
            let route = switch (Catalog.find(request.ledger)) {
                case (?catalog) switch (catalog.native_route) {
                    case (?value) value;
                    case null return #err("Ledger has no native withdrawal route");
                };
                case null return #err("Ledger has no native withdrawal route");
            };
            let result = await* Withdrawals.quote(route, request.ledger, request.amount, calls);
            switch (selectedLedger(request.ledger)) { case (#err(error)) return #err(error); case (_) {} };
            result;
        };

        public func /*update*/wallet_transfer_v2(request : WalletTransferRequestV2) : async* WalletTransferResultV2 {
            switch (wallet_transfer_prepare_v2(request)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) await* wallet_transfer_resume_v2(request.request_id);
            };
        };

        // Preparation commits the complete intent without awaiting or moving
        // value. Execution starts only after the UI receives this durable ID.
        public func /*update*/wallet_transfer_prepare_v2(request : WalletTransferRequestV2) : WalletTransferResultV2 {
            prepareTransfer(request, null);
        };

        // An explicit Ethereum destination does not need an address-book entry.
        // The saved binding distinguishes it from every released contact-bound
        // request, including contacts whose identifiers happen to be zero.
        public func /*update*/wallet_ethereum_withdraw_prepare_v1(request : WalletEthereumWithdrawRequestV1) : WalletTransferResultV2 {
            if (not validEthereumAddress(request.address)) return #err("Enter a valid Ethereum address (0x and 40 hexadecimal characters)");
            let address = Text.toLower(request.address);
            let transfer : WalletTransferRequest = {
                ledger = request.ledger;
                network = #ethereum_mainnet;
                contact_id = 0;
                contact_revision = 0;
                address_id = 0;
                expected_destination = #ethereum_mainnet(address);
                amount = request.amount;
            };
            prepareTransfer({ request_id = request.request_id; transfer; withdrawal_quote = request.withdrawal_quote }, ?#direct_ethereum(address));
        };

        public func /*query*/wallet_ethereum_withdraw_status_v1(id : Blob) : WalletEthereumWithdrawStatusResultV1 {
            let ?command = Map.get(transferMem.commands, Blob.compare, id) else return #ok(null);
            let ?context : ?SavedTransferContext = from_candid command.resolved else return #err("Invalid saved transfer context");
            let ?#direct_ethereum(address) = context.destination_binding else return #ok(null);
            let ?transfer : ?WalletTransferRequest = from_candid command.intent else return #err("Invalid saved transfer intent");
            #ok(?{
                request = { request_id = id; ledger = transfer.ledger; address; amount = transfer.amount; withdrawal_quote = context.withdrawal_quote };
                operation = transferOperation(command);
            });
        };

        func prepareTransfer(request : WalletTransferRequestV2, destinationBinding : ?TransferDestinationBinding) : WalletTransferResultV2 {
            if (request.request_id.size() != REQUEST_ID_BYTES) return #err("Invalid transfer request ID");
            let intent = to_candid (request.transfer);
            switch (Map.get(transferMem.commands, Blob.compare, request.request_id)) {
                case (?saved) {
                    if (saved.intent != intent) return #err("Transfer request ID already belongs to a different intent");
                    let ?savedContext : ?SavedTransferContext = from_candid saved.resolved else return #err("Invalid saved transfer context");
                    if (savedContext.destination_binding != destinationBinding) return #err("Transfer request ID already belongs to a different destination authorization");
                    if (to_candid (savedContext.withdrawal_quote) != to_candid (request.withdrawal_quote)) return #err("Transfer request ID already belongs to a different withdrawal cost review");
                    return #ok(transferOperation(saved));
                };
                case null {};
            };
            let transfer = request.transfer;
            if (transfer.amount == 0) return #err("Transfer amount must be greater than zero");
            let resolved = switch (destinationBinding) {
                case null switch (resolveTransferDestination(transfer)) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                case (?#direct_ethereum(address)) {
                    switch (validateSavedTransferDestination(transfer, transfer.expected_destination, destinationBinding)) {
                        case (#err(error)) return #err(error);
                        case (#ok(())) {};
                    };
                    { destination = transfer.expected_destination; contact_name = address; address_label = ?"Ethereum" };
                };
            };
            let catalog = Catalog.find(transfer.ledger);
            switch (preflightTransfer(transfer, catalog)) {
                case (#err(error)) return #err(error);
                case (#ok(())) {};
            };
            let native = transfer.network != #internet_computer;
            let route : ?Catalog.NativeRoute = if (native) {
                switch (catalog) { case null null; case (?value) value.native_route };
            } else null;
            let minter = switch (route) { case null null; case (?value) ?catalogRoute(value).minter };
            switch (route, request.withdrawal_quote) {
                case (?#ckerc20(value), ?review) switch (review.gas) {
                    case (?gas) {
                        if (gas.ledger != Principal.fromText(value.cketh_ledger) or gas.minter != Principal.fromText(value.minter)) return #err("Withdrawal gas quote does not match the selected ledger and minter");
                    };
                    case null return #err("Review the ckETH gas quote before withdrawing this token");
                };
                case (?#ckerc20(_), null) return #err("Review the ckETH gas quote before withdrawing this token");
                case (_, ?review) if (review.gas != null) return #err("Unexpected separate gas quote for this withdrawal route");
                case (_) {};
            };
            let allowanceLedgers = switch (route) {
                case (?#ckerc20(value)) [transfer.ledger, Principal.fromText(value.cketh_ledger)];
                case null [];
                case (_) [transfer.ledger];
            };
            switch (minter) {
                case null {};
                case (?spender) {
                    for (ledger in allowanceLedgers.vals()) {
                        if (TransferJournal.allowanceReserved(transferMem, ledger, spender, null) or fundingAllowancePending(ledger, spender)) {
                            return #err("An unresolved operation uses this minter allowance. Resume it before starting another withdrawal.");
                        };
                    };
                };
            };
            let command : TransferMemory.Command = {
                request_id = request.request_id;
                intent;
                resolved = to_candid ({ contact = resolved; route; withdrawal_quote = request.withdrawal_quote; destination_binding = destinationBinding } : SavedTransferContext);
                created_at = nowNanos();
                ledger = transfer.ledger;
                native;
                minter;
                allowance_ledgers = allowanceLedgers;
                var updated_at = Time.now();
                var status = #pending;
                var last_error = null;
                var settlement = null;
                var acknowledged = false;
                var calls = [];
            };
            Map.add(transferMem.commands, Blob.compare, request.request_id, command);
            #ok(transferOperation(command));
        };

        public func /*update*/wallet_transfer_resume_v2(id : Blob) : async* WalletTransferResultV2 {
            switch (Map.get(transferMem.commands, Blob.compare, id)) {
                case null #err("Transfer request was not found");
                case (?command) switch (command.status, partialWithdrawal(command)) {
                    case (#pending, ?partial) await* refreshPartialWithdrawal(command, partial);
                    case (_) await* resumeTransfer(command);
                };
            };
        };

        public func /*query*/wallet_transfer_status_v2(id : Blob) : WalletTransferResultV2 {
            switch (Map.get(transferMem.commands, Blob.compare, id)) {
                case null #err("Transfer request was not found");
                case (?command) #ok(transferOperation(command));
            };
        };

        public func /*query*/wallet_transfers_pending_v2(()) : [WalletTransferOperationV2] {
            let results = List.empty<WalletTransferOperationV2>();
            for ((_, command) in Map.entries(transferMem.commands)) {
                if (command.status == #pending or nativeSettlementPending(command) or not command.acknowledged) List.add(results, transferOperation(command));
            };
            List.toArray(results);
        };

        public func /*update*/wallet_transfer_acknowledge_v2(id : Blob) : WalletTransferResultV2 {
            let ?command = Map.get(transferMem.commands, Blob.compare, id) else return #err("Transfer request was not found");
            if (command.status != #pending) command.acknowledged := true;
            #ok(transferOperation(command));
        };

        func nativeSettlementPending(command : TransferMemory.Command) : Bool {
            if (not command.native) return false;
            switch (command.status) {
                case (#succeeded(_)) switch (command.settlement) {
                    case (?{ status = #confirmed(_) or #failed(_) }) false;
                    case (_) true;
                };
                case (_) false;
            };
        };

        public func /*update*/wallet_transfer_refresh_v2(id : Blob) : async* WalletTransferResultV2 {
            let ?command = Map.get(transferMem.commands, Blob.compare, id) else return #err("Transfer request was not found");
            switch (command.status, partialWithdrawal(command)) {
                case (#pending, ?partial) return await* refreshPartialWithdrawal(command, partial);
                case (_) {};
            };
            let receipt = switch (command.status) {
                case (#succeeded(bytes)) {
                    let ?value : ?WalletTransferReceipt = from_candid bytes else return #err("Invalid saved transfer receipt");
                    value;
                };
                case (_) return #ok(transferOperation(command));
            };
            if (not nativeSettlementPending(command)) return #ok(transferOperation(command));
            let ?context : ?SavedTransferContext = from_candid command.resolved else return #err("Invalid saved transfer context");
            let ?minter = command.minter else return #err("Saved transfer has no minter");
            let ?route = context.route else return #err("Saved transfer has no native route");
            let block : ?Nat = switch (route) {
                // The ckETH gas-burn block identifies a ckERC20 withdrawal.
                case (#ckerc20(_)) receipt.secondary_block_index;
                case (_) ?receipt.block_index;
            };
            switch (block) {
                case null {
                    command.settlement := ?{ checked_at = Time.now(); status = #unknown("The saved withdrawal receipt has no required gas-burn identifier.") };
                    command.acknowledged := false;
                };
                case (?value) {
                    if (value > TransferSettlement.MAX_WITHDRAWAL_ID) {
                        command.settlement := ?{ checked_at = Time.now(); status = #unknown("Saved withdrawal ID is outside the minter protocol's Nat64 representation") };
                        command.acknowledged := false;
                    } else {
                        let withdrawalId = Nat64.fromNat(value);
                        let request = switch (route) {
                            case (#ckbtc(_)) TransferSettlement.requestBtc(minter, withdrawalId);
                            case (#ckdoge(_)) TransferSettlement.requestDoge(minter, withdrawalId);
                            case (#cksol(_)) TransferSettlement.requestSol(minter, withdrawalId);
                            case (_) TransferSettlement.request(minter, withdrawalId);
                        };
                        let result = await* calls.call(request);
                        // A concurrent completed refresh must not be replaced
                        // by an older unavailable/pending reply.
                        if (nativeSettlementPending(command)) {
                            let status = switch (route) {
                                case (#ckbtc(_) or #ckdoge(_)) TransferSettlement.classifyUtxo(result);
                                case (#cksol(_)) TransferSettlement.classifySol(result);
                                case (_) TransferSettlement.classify(result);
                            };
                            command.settlement := ?{ checked_at = Time.now(); status };
                            command.acknowledged := false;
                        };
                    };
                };
            };
            switch (command.settlement) {
                case (?{ status = #confirmed(value) }) recordNativeTransactionHash(command, receipt, context, value.transaction_hash);
                case (?{ status = #submitted(value) }) recordNativeTransactionHash(command, receipt, context, value.transaction_hash);
                case (_) {};
            };
            command.updated_at := Time.now();
            #ok(transferOperation(command));
        };

        func recordNativeTransactionHash(command : TransferMemory.Command, receipt : WalletTransferReceipt, context : SavedTransferContext, hash : Text) {
            func attach(ledger : Principal, block : Nat) {
                let ?storedLedger = Map.get(mem.ledgers, Principal.compare, ledger) else return;
                let ?transaction = Map.get(storedLedger.history.transactions, Nat.compare, block) else return;
                let ?native = transaction.native else return;
                ignore HistoryStore.putTransaction(mem, ledger, { transaction with native = ?{ native with transaction_id = ?hash } });
            };
            attach(command.ledger, receipt.block_index);
            switch (context.route, receipt.secondary_block_index) {
                case (?#ckerc20(route), ?block) attach(Principal.fromText(route.cketh_ledger), block);
                case (_) {};
            };
        };

        func fundingAllowancePending(ledger : Principal, spender : Principal) : Bool {
            for ((_, command) in Map.entries(commandMem.commands)) {
                switch (command.status, command.operation) {
                    case (#pending(_), #approve(value)) {
                        if (command.ledger == ledger and value.spender.owner == spender and value.spender.subaccount == null) return true;
                    };
                    case (_) {};
                };
            };
            false;
        };

        func transferOperation(command : TransferMemory.Command) : WalletTransferOperationV2 {
            let ?request : ?WalletTransferRequest = from_candid command.intent else Runtime.trap("Invalid saved transfer intent");
            let status = switch (command.status) {
                case (#pending) #pending;
                case (#rejected(error)) #rejected(error);
                case (#succeeded(bytes)) {
                    let ?receipt : ?WalletTransferReceipt = from_candid bytes else Runtime.trap("Invalid saved transfer receipt");
                    #succeeded(receipt);
                };
            };
            {
                request_id = command.request_id;
                ledger = command.ledger;
                amount = request.amount;
                native = command.native;
                destination = destinationText(request.expected_destination);
                created_at_ns = command.created_at;
                message = command.last_error;
                settlement = command.settlement;
                status;
            };
        };

        func resumeTransfer(command : TransferMemory.Command) : async* WalletTransferResultV2 {
            if (command.status != #pending) return #ok(transferOperation(command));
            if (transferInFlight) {
                command.last_error := ?"Another Wallet transfer or approval is in progress. Resume this saved request afterward.";
                return #ok(transferOperation(command));
            };
            let ?request : ?WalletTransferRequest = from_candid command.intent else return #err("Invalid saved transfer intent");
            let ?context : ?SavedTransferContext = from_candid command.resolved else return #err("Invalid saved transfer destination");
            let resolved = context.contact;
            transferInFlight := true;
            let replay = TransferJournal.Replay(command, calls);
            switch (context.route) {
                case (?#ckerc20(value)) {
                    let minter = Principal.fromText(value.minter);
                    // Only new sequences receive this optional read prefix.
                    // Existing released fee/approval bytes keep their positions.
                    if (command.calls.size() == 0 or isRefundTail(command.calls[0], minter)) {
                        let result = await* replay.backend_calls.call(TransferRefund.tailRequest(minter));
                        switch (result) {
                            case (#err(error)) {
                                // A failed pre-dispatch read stays failed: a
                                // later retry must not substitute a tail captured
                                // after the withdrawal. Recovery can scan backwards.
                                command.calls[0].outcome := #rejected(error);
                            };
                            case (_) {};
                        };
                    };
                };
                case (_) {};
            };
            let feeResult = Icrc.decodeFee(await* replay.backend_calls.call(Icrc.feeRequest(request.ledger)));
            let result : WalletTransferResult = switch (feeResult) {
                case (#err(error)) #err("Could not read the ledger fee: " # error);
                case (#ok(fee)) {
                    // Exact already-dispatched transfers can reconcile after a
                    // contact edit. New effects still recheck the contact.
                    let validation = if ((replay.dispatched() and not command.native) or TransferJournal.minterDispatched(command)) #ok(()) else validateSavedTransferDestination(request, resolved.destination, context.destination_binding);
                    switch (validation) {
                        case (#err(error)) #err(error);
                        case (#ok(())) {
                            if (not command.native) {
                                await* transferIcrc(request, resolved, fee, replay.backend_calls, command.created_at, ?command.request_id);
                            } else switch (context.route) {
                                case (?route) await* transferNative(request, resolved, route, fee, replay.backend_calls, command.created_at, TransferJournal.minterDispatched(command), ?command.request_id, context.withdrawal_quote, context.destination_binding);
                                case null #err("Saved native route is missing");
                            };
                        };
                    };
                };
            };
            switch (result) {
                case (#ok(receipt)) {
                    command.status := #succeeded(to_candid (receipt));
                    command.last_error := null;
                    if (command.native and command.settlement == null) {
                        command.settlement := ?{ checked_at = Time.now(); status = #pending("The minter accepted the burn. Native payment is still pending.") };
                    };
                };
                case (#err(error)) {
                    command.last_error := ?error;
                    switch (partialWithdrawal(command)) {
                        case (?partial) if (command.settlement == null) {
                            command.settlement := ?{ checked_at = Time.now(); status = #pending("The ckETH gas burn " # Nat.toText(partial.withdrawal_id) # " is saved. The withdrawal failed after that burn; check its reimbursement.") };
                        };
                        case (_) {};
                    };
                    if (not replay.hasUnknown()) {
                        // Cached successful minter replies cannot become a new
                        // failed command because a contact was edited later.
                        if (not TransferJournal.hasUnresolved(command)) command.status := #rejected(error);
                    };
                };
            };
            command.updated_at := Time.now();
            transferInFlight := false;
            #ok(transferOperation(command));
        };

        func partialWithdrawal(command : TransferMemory.Command) : ?TransferRefund.PartialFailure {
            if (not command.native) return null;
            for (step in command.calls.vals()) {
                if (command.minter == ?step.canister and step.method == "withdraw_erc20") switch (step.outcome) {
                    case (#reply(reply)) return TransferRefund.partialFailure(reply);
                    case (_) {};
                };
            };
            null;
        };

        func isRefundTail(step : TransferMemory.Step, minter : Principal) : Bool {
            let request = TransferRefund.tailRequest(minter);
            step.canister == request.canister and step.method == request.method and step.args == request.args and step.cycles == request.cycles;
        };

        func savedRefundTail(command : TransferMemory.Command, minter : Principal) : ?Nat64 {
            if (command.calls.size() == 0 or not isRefundTail(command.calls[0], minter)) return null;
            switch (command.calls[0].outcome) {
                case (#reply(reply)) TransferRefund.tail(#ok(reply));
                case (_) null;
            };
        };

        func savedGasReimbursement(command : TransferMemory.Command, burn : Nat) : ?TransferRefund.Reimbursed {
            for (step in command.calls.vals()) {
                if (command.minter == ?step.canister and step.method == "get_events") switch (step.outcome) {
                    case (#reply(reply)) {
                        let ?args : ?{ start : Nat64; length : Nat64 } = from_candid step.args else return null;
                        if (args.length > 0) switch (TransferRefund.inspect(#ok(reply), burn, args.start)) {
                            case (#ok({ evidence = ?#reimbursed(value) })) return ?value;
                            case (_) {};
                        };
                    };
                    case (_) {};
                };
            };
            null;
        };

        func recordGasReimbursement(command : TransferMemory.Command, partial : TransferRefund.PartialFailure, value : TransferRefund.Reimbursed) {
            let evidence = "ckETH gas burn " # Nat.toText(value.withdrawal_id) # " was reimbursed with " # Nat.toText(value.reimbursed_amount) # " atoms in ledger block " # Nat.toText(value.reimbursed_in_block) # ".";
            let message = if (partial.asset_burn_unresolved) {
                evidence # " The token burn outcome is still unresolved. This withdrawal will not be sent again.";
            } else evidence # " The token burn was rejected; no native withdrawal was created.";
            command.settlement := ?{
                checked_at = Time.now();
                status = if (partial.asset_burn_unresolved) #unknown(message) else #failed(message);
            };
            if (not partial.asset_burn_unresolved) command.status := #rejected(message);
            command.last_error := ?message;
            command.acknowledged := false;
            command.updated_at := Time.now();
        };

        func refreshPartialWithdrawal(command : TransferMemory.Command, partial : TransferRefund.PartialFailure) : async* WalletTransferResultV2 {
            if (command.status != #pending) return #ok(transferOperation(command));
            switch (savedGasReimbursement(command, partial.withdrawal_id)) {
                case (?value) {
                    recordGasReimbursement(command, partial, value);
                    return #ok(transferOperation(command));
                };
                case null {};
            };
            let ?minter = command.minter else return #err("Saved partial withdrawal has no minter");
            let cursor : RefundCursor = switch (Map.get(refundCursors, Blob.compare, command.request_id)) {
                case (?value) value;
                case null switch (savedRefundTail(command, minter)) {
                    case (?start) ({ start; tail = start; backwards = false; latest_evidence = null } : RefundCursor);
                    case null {
                        // Released commands have no pre-dispatch anchor. Search
                        // their exact burn ID from the current tail backwards;
                        // no timestamp or amount heuristic excludes any event.
                        let result = await* calls.call(TransferRefund.tailRequest(minter));
                        if (command.status != #pending) return #ok(transferOperation(command));
                        let ?tail = TransferRefund.tail(result) else {
                            command.settlement := ?{ checked_at = Time.now(); status = #unknown("Could not read the minter event tail. The partial withdrawal remains unresolved; retrying only checks its reimbursement.") };
                            return #ok(transferOperation(command));
                        };
                        {
                            start = if (tail > TransferRefund.pageSize) tail - TransferRefund.pageSize else (0 : Nat64);
                            tail;
                            backwards = true;
                            latest_evidence = null;
                        };
                    };
                };
            };
            let request = TransferRefund.request(minter, cursor.start);
            let result = await* calls.call(request);
            if (command.status != #pending) return #ok(transferOperation(command));
            let page = switch (TransferRefund.inspect(result, partial.withdrawal_id, cursor.start)) {
                case (#err(error)) {
                    command.settlement := ?{ checked_at = Time.now(); status = #unknown(error) };
                    return #ok(transferOperation(command));
                };
                case (#ok(value)) value;
            };
            let newer = switch (cursor.latest_evidence, page.evidence_index) {
                case (null, ?_) true;
                case (?previous, ?current) current >= previous;
                case (_) false;
            };
            let next : RefundCursor = if (cursor.backwards) {
                if (cursor.start == 0) {
                    { start = cursor.tail; tail = cursor.tail; backwards = false; latest_evidence = if (newer) page.evidence_index else cursor.latest_evidence };
                } else {
                    { start = if (cursor.start > TransferRefund.pageSize) cursor.start - TransferRefund.pageSize else (0 : Nat64); tail = cursor.tail; backwards = true; latest_evidence = if (newer) page.evidence_index else cursor.latest_evidence };
                };
            } else {
                { start = page.next; tail = cursor.tail; backwards = false; latest_evidence = if (newer) page.evidence_index else cursor.latest_evidence };
            };
            Map.add(refundCursors, Blob.compare, command.request_id, next);
            // The scan cursor is an optimization in this runtime. The original
            // burn, optional pre-dispatch tail and matched refund proof are
            // durable; runtime reinitialization safely restarts read-only scans.
            if (newer) switch (page.evidence) {
                case (?#reimbursed(value)) {
                    switch (result) {
                        case (#ok(reply)) command.calls := Array.concat<TransferMemory.Step>(command.calls, [{
                            canister = request.canister; method = request.method; args = request.args; cycles = request.cycles;
                            var outcome = #reply(reply);
                        }]);
                        case (_) {};
                    };
                    recordGasReimbursement(command, partial, value);
                    return #ok(transferOperation(command));
                };
                case (?#scheduled(value)) {
                    let message = if (value.to != calls.canister_principal or value.to_subaccount != null) {
                        "The matching reimbursement event has an unexpected IC recipient. The partial withdrawal remains unresolved.";
                    } else "ckETH gas burn " # Nat.toText(value.withdrawal_id) # " is awaiting reimbursement of " # Nat.toText(value.reimbursed_amount) # " atoms.";
                    command.settlement := ?{ checked_at = Time.now(); status = #pending(message) };
                };
                case (?#quarantined(_)) command.settlement := ?{ checked_at = Time.now(); status = #unknown("The minter quarantined the reimbursement for this exact ckETH gas burn. Its outcome remains unresolved; Wallet will not repeat the withdrawal.") };
                case (?#unexpected_transaction(_)) command.settlement := ?{ checked_at = Time.now(); status = #unknown("The matching reimbursement event refers to an unexpected native transaction. The partial withdrawal remains unresolved.") };
                case null {};
            } else if (cursor.latest_evidence == null) {
                let progress = if (next.backwards) {
                    "Checking earlier reimbursement events; the next page starts at event " # Nat64.toText(next.start) # ".";
                } else if (page.exhausted and not cursor.backwards) {
                    "No matching reimbursement is recorded yet. Later checks continue from the current event tail.";
                } else "Checking reimbursement events from event " # Nat64.toText(next.start) # ".";
                command.settlement := ?{ checked_at = Time.now(); status = #pending(progress # " The exact ckETH gas burn remains saved. Scan position may restart after a runtime upgrade.") };
            };
            command.updated_at := Time.now();
            #ok(transferOperation(command));
        };

        public func /*update*/wallet_bridge_quote_v1(ledger : Principal) : async* WalletBridgeQuoteResultV1 { await* bridge.quote(ledger) };
        public func /*update*/wallet_bridge_prepare_v1(request : WalletBridgePrepareRequestV1) : async* WalletBridgeIntentResultV1 {
            switch (bridgeProvider.requireLegacy(request.id)) { case (#err(error)) return #err(error); case (_) {} };
            await* bridge.prepare(request);
        };
        public func /*query*/wallet_bridge_provider_binding_v1(id : Blob) : WalletBridgeProviderBindingResultV1 { bridgeProvider.lookup(id) };
        public func /*update*/wallet_bridge_provider_prepare_v1(request : WalletBridgeProviderPrepareRequestV1) : async* WalletBridgeIntentResultV1 {
            switch (bridgeProvider.reserve(request)) { case (#err(error)) return #err(error); case (_) {} };
            await* bridge.prepare(request.bridge);
        };
        public func /*query*/wallet_bridge_list_v1(request : WalletBridgeListRequestV1) : WalletBridgePageV1 { bridge.list(request) };
        public func /*query*/wallet_bridge_status_v1(id : Blob) : WalletBridgeIntentResultV1 { bridge.status(id) };
        public func /*query*/wallet_bridge_activity_v1(request : WalletBridgeActivityRequestV1) : WalletBridgeActivityResultV1 { bridgeActivity.list(request) };
        public func /*update*/wallet_bridge_step_v2(request : WalletBridgeStepActionV2) : WalletBridgeIntentResultV1 {
            switch (request) {
                case (#claim(value)) bridge.claim(value);
                case (#record(value)) bridge.recordStep(value);
                case (#dismiss(value)) bridgeActivity.dismiss(value);
            };
        };
        public func /*update*/wallet_bridge_claim_v1(request : WalletBridgeClaimRequestV1) : WalletBridgeIntentResultV1 { bridge.claim(request) };
        public func /*update*/wallet_bridge_record_step_v1(request : WalletBridgeRecordStepRequestV1) : WalletBridgeIntentResultV1 { bridge.recordStep(request) };
        public func /*update*/wallet_bridge_replacement_v1(request : WalletBridgeReplacementActionV1) : WalletBridgeReplacementResultV1 {
            switch (request) {
                case (#lookup(value)) #ok(#hash(bridge.effectiveHash(value.id, value.step)));
                case (#record(value)) switch (bridge.recordReplacement(value)) {
                    case (#ok(intent)) #ok(#intent(intent));
                    case (#err(error)) #err(error);
                };
            };
        };
        public func /*update*/wallet_bridge_refresh_v1(request : WalletBridgeRefreshRequestV1) : async* WalletBridgeIntentResultV1 { await* bridge.refresh(request) };

        func fundingPreview(
            value : WalletFundingPreviewRequestV1,
        ) : WalletFundingPreviewResultV1 {
            let request = value.request;
            let now = nowNanos();
            switch (validateFundingKey(request)) { case (#err(error)) return #err(error); case (_) {} };
            if ((to_candid(request)).size() > MAX_FUNDING_INTENT_BYTES) return #err("Funding request exceeds the Wallet size limit");
            let key : CommandMemory.CommandKey = { caller_app_id = request.caller.app_id; request_id = request.request_id };
            switch (existingFundingCommand(key, request, if (value.lookup_only) 0 else now)) {
                case (#err(error)) return #err(error);
                case (#ok(?outcome)) switch (if (value.lookup_only) #ok(outcome) else validateExistingFundingOutcome(request, outcome, now)) {
                    case (#err(error)) return #err(error);
                    case (#ok(preparation)) return #ok({ preparation = ?preparation; durable = true });
                };
                case (_) {};
            };
            // Read-only cancellation lookup validates the same durable intent,
            // but expired or deselected unsigned reviews must still be closable.
            if (value.lookup_only) return #ok({ preparation = null; durable = false });
            switch (validateCurrentFundingAuthority(request, now)) { case (#err(error)) return #err(error); case (_) {} };
            let ?facts = value.facts else return #ok({ preparation = null; durable = false });
            if (facts.owner != calls.canister_principal) return #err("Wallet preview belongs to another account");
            let metadata = switch (decodeFundingMetadata(#ok(to_candid(facts.metadata)), #ok(to_candid(facts.fee)))) {
                case (#err(error)) return #err(error); case (#ok(result)) result;
            };
            let current = switch (facts.allowance) {
                case null null;
                case (?allowance) switch (decodeCurrentAllowance(#ok(to_candid(allowance)))) {
                    case (#err(error)) return #err(error); case (#ok(result)) ?result;
                };
            };
            let prepared = switch (prepareDirectFunding(request, metadata, current)) {
                case (#err(error)) return #err(error); case (#ok(result)) result;
            };
            let command = newFundingCommand(request, prepared);
            #ok({ durable = false; preparation = ?#prepared({ command_id = commandId(key); review = fundingReview(key, command) }) });
        };

        func newFundingCommand(request : WalletFundingPrepareRequestV1, prepared : PreparedFunding) : CommandMemory.Command {
            {
                caller = {
                    endpoint = request.caller.endpoint;
                    app_id = request.caller.app_id;
                    role = request.caller.role;
                    agent_mode = request.agent_mode;
                };
                ledger = request.ledger;
                operation = prepared.operation;
                intent = to_candid(request);
                prepared_at = Time.now();
                valid_until = request.valid_until_ns;
                retain_until = Int.fromNat(Nat64.toNat(request.valid_until_ns)) +
                    COMMAND_RETENTION_NS;
                review = prepared.review;
                var call_args : ?Blob = null;
                var updated_at : Int = Time.now();
                var status : CommandMemory.Status = #prepared;
            };
        };

        public func /*update*/wallet_funding_prepare_v1(
            request : WalletFundingPrepareRequestV1,
        ) : async* WalletFundingPrepareResultV1 {
            let now = nowNanos();
            switch (validateFundingKey(request)) {
                case (#err(error)) return #err(error);
                case (#ok(())) {};
            };
            let key : CommandMemory.CommandKey = {
                caller_app_id = request.caller.app_id;
                request_id = request.request_id;
            };
            let intent = to_candid (request);
            if (intent.size() > MAX_FUNDING_INTENT_BYTES) {
                return #err("Funding request exceeds the Wallet size limit");
            };
            switch (existingFundingCommand(key, request, now)) {
                case (#err(error)) return #err(error);
                case (#ok(?outcome)) {
                    return validateExistingFundingOutcome(request, outcome, now);
                };
                case (#ok(null)) {};
            };
            switch (validateCurrentFundingAuthority(request, now)) {
                case (#err(error)) return #err(error);
                case (#ok(())) {};
            };
            switch (existingActiveIcpRevoke(request, now)) {
                case (#err(error)) return #err(error);
                case (#ok(?outcome)) {
                    return validateExistingFundingOutcome(request, outcome, now);
                };
                case (#ok(null)) {};
            };

            if (not ensureFundingCapacity(Time.now())) {
                return #err("Wallet funding command capacity is full");
            };
            if (
                FundingJournal.activeCommandCount(
                    commandMem.commands,
                    request.caller.app_id,
                ) >=
                MAX_PREPARED_COMMANDS_PER_APP
            ) {
                return #err("This app already has too many unresolved Wallet commands");
            };

            let prepared = switch (await* prepareFundingOperation(request, now)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let finishedAt = nowNanos();
            if (finishedAt > request.valid_until_ns) {
                return #err("Funding request expired during preparation");
            };
            // Another identical prepare may have completed while ledger facts
            // were awaited. Reuse its durable result and never overwrite it.
            switch (existingFundingCommand(key, request, finishedAt)) {
                case (#err(error)) return #err(error);
                case (#ok(?outcome)) {
                    return validateExistingFundingOutcome(request, outcome, finishedAt);
                };
                case (#ok(null)) {};
            };
            // Preparation awaits ledger facts. Recheck the global semantic
            // fence before insertion so two fresh request IDs cannot both
            // prepare the same non-idempotent legacy removal.
            switch (existingActiveIcpRevoke(request, finishedAt)) {
                case (#err(error)) return #err(error);
                case (#ok(?outcome)) {
                    return validateExistingFundingOutcome(request, outcome, finishedAt);
                };
                case (#ok(null)) {};
            };
            // Ledger reads yield to other Wallet updates. Require the ledger to
            // still be selected and the exact route to still be reserved before
            // persisting a fresh owner-reviewable command.
            switch (validateCurrentFundingAuthority(request, finishedAt)) {
                case (#err(error)) return #err(error);
                case (#ok(())) {};
            };
            if (not ensureFundingCapacity(Time.now())) {
                return #err("Wallet funding command capacity is full");
            };
            if (
                FundingJournal.activeCommandCount(
                    commandMem.commands,
                    request.caller.app_id,
                ) >=
                MAX_PREPARED_COMMANDS_PER_APP
            ) {
                return #err("This app already has too many unresolved Wallet commands");
            };

            let command = newFundingCommand(request, prepared);
            Map.add(commandMem.commands, commandKeyCompare, key, command);
            #ok(#prepared({
                command_id = commandId(key);
                review = fundingReview(key, command);
            }));
        };

        public func /*update*/wallet_funding_execute_v1(
            request : WalletFundingExecuteRequestV1,
        ) : async* WalletFundingExecutionResultV1 {
            if (request.command_id.request_id.size() != REQUEST_ID_BYTES) {
                return rejectedExecution(
                    request.command_id,
                    "Invalid Wallet funding command ID",
                );
            };
            let key : CommandMemory.CommandKey = {
                caller_app_id = request.command_id.caller_app_id;
                request_id = request.command_id.request_id;
            };
            let ?command = Map.get(commandMem.commands, commandKeyCompare, key) else {
                return rejectedExecution(request.command_id, "Wallet funding command was not found");
            };
            switch (command.status) {
                case (#succeeded(_)) return fundingExecution(key, command);
                case (#rejected(_)) return fundingExecution(key, command);
                case (#prepared) if (nowNanos() > command.valid_until) {
                    return rejectFundingCommand(
                        key,
                        command,
                        "expired",
                        "Wallet funding command expired before dispatch",
                    );
                };
                case (_) {};
            };
            // Accept is durable even when another Wallet action currently owns
            // the ledger-call slot. A retry then resumes without another owner
            // decision, and reject cannot relabel the accepted command.
            switch (FundingJournal.acceptForExecution(
                command,
                transferInFlight,
                Time.now(),
            )) {
                case (#waiting) return pendingExecution(
                    request.command_id,
                    "Another Wallet transfer or approval is in progress",
                );
                case (#dispatch) {};
            };
            transferInFlight := true;
            let result = await* executeFundingCommand(key, command);
            transferInFlight := false;
            result;
        };

        public func /*update*/wallet_funding_reject_v1(
            request : WalletFundingExecuteRequestV1,
        ) : async* WalletFundingExecutionResultV1 {
            if (request.command_id.request_id.size() != REQUEST_ID_BYTES) {
                return rejectedExecution(
                    request.command_id,
                    "Invalid Wallet funding command ID",
                );
            };
            let key : CommandMemory.CommandKey = {
                caller_app_id = request.command_id.caller_app_id;
                request_id = request.command_id.request_id;
            };
            let ?command = Map.get(commandMem.commands, commandKeyCompare, key) else {
                return rejectedExecution(request.command_id, "Wallet funding command was not found");
            };
            switch (command.status) {
                case (#prepared) rejectFundingCommand(
                    key,
                    command,
                    "owner_rejected",
                    "Wallet funding was rejected by the owner",
                );
                // Reject is deliberately incapable of relabeling a dispatched
                // or terminal command. The durable execution journal remains
                // authoritative once an accepted operation starts.
                case (_) fundingExecution(key, command);
            };
        };

        func validateFundingRequest(
            request : WalletFundingPrepareRequestV1,
            now : Nat64,
        ) : IcrcTypes.Result<()> {
            if (
                request.valid_until_ns <= now or
                request.valid_until_ns - now > MAX_FUNDING_VALIDITY_NS
            ) {
                return #err("Wallet funding validity is outside the allowed window");
            };
            switch (selectedLedger(request.ledger)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            switch (request.intent) {
                case (#direct(value)) {
                    if (value.amount_atoms == 0) {
                        return #err("Direct funding amount must be greater than zero");
                    };
                    if (not FundingDisplay.nat(value.amount_atoms)) {
                        return #err("Direct funding amount exceeds the Wallet protocol limit");
                    };
                    switch (canonicalFundingAccount(value.to)) {
                        case (#err(error)) return #err(error);
                        case (#ok(_)) {};
                    };
                    switch (value.memo) {
                        case (?memo) if (memo.size() > MAX_FUNDING_MEMO_BYTES) {
                            return #err("Direct funding memo exceeds the Wallet limit");
                        };
                        case (_) {};
                    };
                };
                case (#allowance(value)) {
                    if (value.amount_atoms == 0) {
                        return #err("Allowance funding amount must be greater than zero");
                    };
                    if (not FundingDisplay.nat(value.amount_atoms)) {
                        return #err("Allowance funding amount exceeds the Wallet protocol limit");
                    };
                    if (
                        value.expires_at_ns <= now or
                        value.expires_at_ns - now > MAX_ALLOWANCE_LIFETIME_NS or
                        value.expires_at_ns < request.valid_until_ns
                    ) {
                        return #err("Allowance expiration is outside the Wallet limit");
                    };
                    switch (canonicalAllowanceSpender(value.spender)) {
                        case (#err(error)) return #err(error);
                        case (#ok(_)) {};
                    };
                };
                case (#revoke(value)) {
                    if (value.expected_allowance_atoms == 0) {
                        return #err("The approval is already zero");
                    };
                    if (not FundingDisplay.nat(value.expected_allowance_atoms)) {
                        return #err("Expected allowance exceeds the Wallet protocol limit");
                    };
                    switch (value.source, value.spender) {
                        case (#icrc, #icrc(account)) {
                            if (isIcpLedger(request.ledger)) {
                                return #err("ICP approvals use the legacy revoke route");
                            };
                            switch (canonicalIcrcAccount(account)) {
                                case (#err(error)) return #err(error);
                                case (#ok(_)) {};
                            };
                        };
                        case (#icp, #icp_account_identifier(spender)) {
                            if (not isIcpLedger(request.ledger)) {
                                return #err("Legacy ICP revoke requires the ICP ledger");
                            };
                            if (spender.size() != 32) {
                                return #err("Invalid ICP spender account identifier");
                            };
                        };
                        case (_) return #err("Approval source and spender type do not match");
                    };
                };
            };
            #ok(());
        };

        func validateFundingKey(
            request : WalletFundingPrepareRequestV1,
        ) : IcrcTypes.Result<()> {
            if (request.request_id.size() != REQUEST_ID_BYTES) {
                return #err("Wallet funding request_id must be exactly 16 bytes");
            };
            if (
                request.caller.app_id.size() == 0 or
                request.caller.app_id.size() > 64 or
                request.caller.endpoint.size() == 0 or
                request.caller.endpoint.size() > 256
            ) {
                return #err("Invalid Wallet funding caller identity");
            };
            switch (request.caller.role) {
                case (?role) if (role.size() == 0 or role.size() > 32) {
                    return #err("Invalid Wallet funding caller role");
                };
                case (_) {};
            };
            #ok(());
        };

        func prepareDirectFunding(
            request : WalletFundingPrepareRequestV1,
            metadata : FundingMetadata,
            observedAllowance : ?CurrentApproval,
        ) : IcrcTypes.Result<PreparedFunding> {
            switch (request.intent) {
                case (#direct(value)) {
                    let destination = switch (canonicalFundingAccount(value.to)) {
                        case (#err(error)) return #err(error);
                        case (#ok(account)) account;
                    };
                    let totalDebit = value.amount_atoms + metadata.fee;
                    if (not FundingDisplay.nat(totalDebit)) {
                        return #err("Direct funding total exceeds the Wallet protocol limit");
                    };
                    #ok({
                        operation = #transfer({
                            to = destination;
                            amount = value.amount_atoms;
                            memo = value.memo;
                        });
                        review = {
                            token_name = metadata.name;
                            token_symbol = metadata.symbol;
                            decimals = metadata.decimals;
                            fee = metadata.fee;
                            transfer_fee = null;
                            current_allowance = null;
                            current_expires_at = null;
                            allowance = null;
                            total_debit = totalDebit;
                            expires_at = null;
                        };
                    });
                };
                case (#allowance(value)) {
                    let spender = switch (canonicalAllowanceSpender(value.spender)) {
                        case (#err(error)) return #err(error);
                        case (#ok(account)) account;
                    };
                    let ?current = observedAllowance else return #err("Current allowance is unavailable");
                    let desired = value.amount_atoms + metadata.fee;
                    let totalDebit = desired + metadata.fee;
                    if (
                        not FundingDisplay.nat(desired) or
                        not FundingDisplay.nat(totalDebit)
                    ) {
                        return #err("Allowance funding total exceeds the Wallet protocol limit");
                    };
                    #ok({
                        operation = #approve({
                            spender;
                            amount = value.amount_atoms;
                            expected_allowance = current.amount;
                            expected_expires_at = current.expires_at;
                            expires_at = value.expires_at_ns;
                        });
                        review = {
                            token_name = metadata.name;
                            token_symbol = metadata.symbol;
                            decimals = metadata.decimals;
                            fee = metadata.fee;
                            transfer_fee = ?metadata.fee;
                            current_allowance = ?current.amount;
                            current_expires_at = current.expires_at;
                            allowance = ?desired;
                            total_debit = totalDebit;
                            expires_at = ?value.expires_at_ns;
                        };
                    });
                };
                case (#revoke(_)) #err("Approval removal requires its existing Wallet review");
            };
        };

        func prepareFundingOperation(
            request : WalletFundingPrepareRequestV1,
            now : Nat64,
        ) : async* IcrcTypes.Result<PreparedFunding> {
            let (metadata, current) = switch (request.intent) {
                case (#allowance(value)) {
                    let spender = switch (canonicalAllowanceSpender(value.spender)) { case (#err(error)) return #err(error); case (#ok(result)) result };
                    let replies = await* calls.call_batch([
                        Icrc.metadataRequest(request.ledger), Icrc.feeRequest(request.ledger),
                        Icrc.allowanceRequest(request.ledger, { owner = calls.canister_principal; subaccount = null }, spender),
                    ]);
                    if (replies.size() != 3) return #err("Wallet backend returned an incomplete funding batch");
                    let metadata = switch (decodeFundingMetadata(replies[0], replies[1])) { case (#err(error)) return #err(error); case (#ok(result)) result };
                    let allowance = switch (decodeCurrentAllowance(replies[2])) { case (#err(error)) return #err(error); case (#ok(result)) result };
                    (metadata, ?allowance);
                };
                case (_) {
                    let metadata = switch (await* readFundingMetadata(request.ledger)) { case (#err(error)) return #err(error); case (#ok(result)) result };
                    (metadata, null);
                };
            };
            switch (request.intent) {
                case (#direct(_)) prepareDirectFunding(request, metadata, null);
                case (#allowance(_)) prepareDirectFunding(request, metadata, current);
                case (#revoke(value)) {
                    switch (value.spender) {
                        case (#icrc(account)) {
                            let spender = switch (canonicalIcrcAccount(account)) {
                                case (#err(error)) return #err(error);
                                case (#ok(canonical)) canonical;
                            };
                            let current = switch (await* readIcrcAllowance(
                                request.ledger,
                                spender,
                            )) {
                                case (#err(error)) return #err(error);
                                case (#ok(allowance)) allowance;
                            };
                            if (
                                current.amount != value.expected_allowance_atoms or
                                current.expires_at != value.expected_expires_at_ns
                            ) {
                                return #err("Approval changed; refresh Wallet approvals");
                            };
                            #ok({
                                operation = #revoke({
                                    spender = #icrc(spender);
                                    expected_allowance = current.amount;
                                    expected_expires_at = current.expires_at;
                                });
                                review = revokeReview(metadata, current);
                            });
                        };
                        case (#icp_account_identifier(spender)) {
                            let current = switch (await* findIcpAllowance(
                                request.ledger,
                                spender,
                                now,
                            )) {
                                case (#err(error)) return #err(error);
                                case (#ok(null)) return #err("ICP approval is no longer active");
                                case (#ok(?allowance)) allowance;
                            };
                            if (
                                current.amount != value.expected_allowance_atoms or
                                current.expires_at != value.expected_expires_at_ns
                            ) {
                                return #err("ICP approval changed; refresh Wallet approvals");
                            };
                            #ok({
                                operation = #revoke({
                                    spender = #icp_account_identifier(spender);
                                    expected_allowance = current.amount;
                                    expected_expires_at = current.expires_at;
                                });
                                review = revokeReview(metadata, current);
                            });
                        };
                    };
                };
            };
        };

        func existingFundingCommand(
            key : CommandMemory.CommandKey,
            request : WalletFundingPrepareRequestV1,
            now : Nat64,
        ) : IcrcTypes.Result<?WalletFundingPrepareOutcomeV1> {
            let ?command = Map.get(commandMem.commands, commandKeyCompare, key) else {
                return #ok(null);
            };
            // W306-W309 stored the complete request, including its disposable
            // endpoint UUID. Compare every retry using only the endpoint from
            // that stored caller; no arbitrary historical endpoint is accepted.
            let comparableIntent = fundingIntentForEndpoint(
                request,
                command.caller.endpoint,
            );
            if (command.intent != comparableIntent) {
                return #err("Wallet funding request ID conflicts with another intent");
            };
            let outcome = switch (command.status) {
                case (#prepared) {
                    if (now > command.valid_until) {
                        return #err("Wallet funding request expired before dispatch");
                    };
                    #prepared({
                        command_id = commandId(key);
                        review = fundingReview(key, command);
                    });
                };
                case (_) #completed({
                    review = fundingReview(key, command);
                    result = fundingExecution(key, command);
                });
            };
            #ok(?outcome);
        };

        func fundingIntentForEndpoint(
            request : WalletFundingPrepareRequestV1,
            endpoint : Text,
        ) : Blob {
            let encoded : WalletFundingPrepareRequestV1 = {
                request with
                caller = { request.caller with endpoint };
            };
            to_candid (encoded);
        };

        func fundingCaller(
            request : WalletFundingPrepareRequestV1,
        ) : CommandMemory.Caller {
            {
                endpoint = request.caller.endpoint;
                app_id = request.caller.app_id;
                role = request.caller.role;
                agent_mode = request.agent_mode;
            };
        };

        func validateExistingFundingOutcome(
            request : WalletFundingPrepareRequestV1,
            outcome : WalletFundingPrepareOutcomeV1,
            now : Nat64,
        ) : IcrcTypes.Result<WalletFundingPrepareOutcomeV1> {
            switch (outcome) {
                // Never-dispatched commands still depend on the owner's current
                // Wallet selection. Pending and terminal results must remain
                // available for exact replay and ambiguous-call reconciliation.
                case (#prepared(_)) switch (validateCurrentFundingAuthority(request, now)) {
                    case (#err(error)) return #err(error);
                    case (#ok(())) {};
                };
                case (#completed(_)) {};
            };
            #ok(outcome);
        };

        func validateCurrentFundingAuthority(
            request : WalletFundingPrepareRequestV1,
            now : Nat64,
        ) : IcrcTypes.Result<()> {
            switch (validateFundingRequest(request, now)) {
                case (#err(error)) return #err(error);
                case (#ok(())) {};
            };
            preflightFundingCapabilities(request);
        };

        func existingActiveIcpRevoke(
            request : WalletFundingPrepareRequestV1,
            now : Nat64,
        ) : IcrcTypes.Result<?WalletFundingPrepareOutcomeV1> {
            let (#revoke(revoke)) = request.intent else return #ok(null);
            let (#icp) = revoke.source else return #ok(null);
            let (#icp_account_identifier(spender)) = revoke.spender else return #ok(null);
            let caller = fundingCaller(request);
            switch (FundingJournal.activeIcpRevoke(
                commandMem.commands,
                caller,
                request.ledger,
                spender,
                revoke.expected_allowance_atoms,
                revoke.expected_expires_at_ns,
                now,
            )) {
                case (#none) #ok(null);
                case (#blocked) #err(
                    "Another ICP approval removal for this spender is already active"
                );
                case (#resume(value)) switch (value.command.status) {
                    case (#prepared) #ok(?#prepared({
                        command_id = commandId(value.key);
                        review = fundingReview(value.key, value.command);
                    }));
                    case (_) #ok(?#completed({
                        review = fundingReview(value.key, value.command);
                        result = fundingExecution(value.key, value.command);
                    }));
                };
            };
        };

        func ensureFundingCapacity(now : Int) : Bool {
            ignore FundingJournal.pruneExpiredCommands(
                commandMem.commands,
                commandKeyCompare,
                now,
                COMMAND_PRUNE_LIMIT,
            );
            Map.size(commandMem.commands) < COMMAND_CAPACITY;
        };

        func preflightFundingCapabilities(
            request : WalletFundingPrepareRequestV1,
        ) : IcrcTypes.Result<()> {
            for (method in ["icrc1_metadata", "icrc1_fee"].vals()) {
                if (not calls.can_call(request.ledger, method)) {
                    return #err("Ledger " # method # " access is not reserved for Wallet");
                };
            };
            switch (request.intent) {
                case (#direct(_)) {
                    if (not calls.can_call(request.ledger, "icrc1_transfer")) {
                        return #err("Ledger transfer access is not reserved for Wallet");
                    };
                };
                case (#allowance(_)) {
                    if (
                        not calls.can_call(request.ledger, "icrc2_allowance") or
                        not calls.can_call(request.ledger, "icrc2_approve")
                    ) {
                        return #err("Ledger allowance access is not reserved for Wallet");
                    };
                };
                case (#revoke(value)) switch (value.source) {
                    case (#icrc) {
                        if (
                            not calls.can_call(request.ledger, "icrc2_allowance") or
                            not calls.can_call(request.ledger, "icrc2_approve")
                        ) {
                            return #err("Ledger allowance access is not reserved for Wallet");
                        };
                    };
                    case (#icp) {
                        if (
                            not calls.can_call(request.ledger, "get_allowances") or
                            not calls.can_call(request.ledger, "remove_approval")
                        ) {
                            return #err("ICP approval access is not reserved for Wallet");
                        };
                    };
                };
            };
            #ok(());
        };

        func readFundingMetadata(
            ledger : Principal,
        ) : async* IcrcTypes.Result<FundingMetadata> {
            let replies = await* calls.call_batch([
                Icrc.metadataRequest(ledger),
                Icrc.feeRequest(ledger),
            ]);
            if (replies.size() != 2) {
                return #err("Wallet backend returned an incomplete ledger metadata batch");
            };
            decodeFundingMetadata(replies[0], replies[1]);
        };

        func decodeFundingMetadata(
            metadataReply : Capabilities.CallResult,
            feeReply : Capabilities.CallResult,
        ) : IcrcTypes.Result<FundingMetadata> {
            let metadata = switch (Icrc.decodeMetadata(metadataReply)) {
                case (#err(error)) return #err("Could not read ledger metadata: " # error);
                case (#ok(value)) value;
            };
            let parsed = switch (parseMetadata(metadata)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let ?symbol = parsed.symbol else {
                return #err("Ledger metadata does not include icrc1:symbol");
            };
            if (
                not FundingDisplay.safeLabel(
                    symbol,
                    FundingDisplay.MAX_TOKEN_SYMBOL_BYTES,
                    false,
                )
            ) {
                return #err("Ledger symbol is empty or unsafe to display");
            };
            switch (parsed.name) {
                case (?name) if (
                    not FundingDisplay.safeLabel(
                        name,
                        FundingDisplay.MAX_TOKEN_NAME_BYTES,
                        true,
                    )
                ) {
                    return #err("Ledger name is empty or unsafe to display");
                };
                case (_) {};
            };
            let ?decimals = parsed.decimals else {
                return #err("Ledger metadata does not include icrc1:decimals");
            };
            let fee = switch (Icrc.decodeFee(feeReply)) {
                case (#err(error)) return #err("Could not read the current ledger fee: " # error);
                case (#ok(value)) value;
            };
            if (not FundingDisplay.nat(fee)) {
                return #err("Ledger fee exceeds the Wallet protocol limit");
            };
            #ok({ name = parsed.name; symbol; decimals; fee });
        };

        func readIcrcAllowance(
            ledger : Principal,
            spender : IcrcTypes.Account,
        ) : async* IcrcTypes.Result<CurrentApproval> {
            let source : IcrcTypes.Account = {
                owner = calls.canister_principal;
                subaccount = null;
            };
            decodeCurrentAllowance(await* calls.call(Icrc.allowanceRequest(ledger, source, spender)));
        };

        func decodeCurrentAllowance(reply : Capabilities.CallResult) : IcrcTypes.Result<CurrentApproval> {
            switch (Icrc.decodeAllowance(reply)) {
                case (#err(error)) #err("Could not read the current allowance: " # error);
                case (#ok(value)) {
                    if (not FundingDisplay.nat(value.allowance)) {
                        return #err("Current allowance exceeds the Wallet protocol limit");
                    };
                    #ok({
                        amount = value.allowance;
                        expires_at = value.expires_at;
                    });
                };
            };
        };

        func findIcpAllowance(
            ledger : Principal,
            spender : Blob,
            now : Nat64,
        ) : async* IcrcTypes.Result<?CurrentApproval> {
            var scan = IcpAllowances.startScan();
            label pages : IcrcTypes.Result<?CurrentApproval> loop {
                let request = switch (IcpAllowances.getAllowancesRequest(
                    ledger,
                    calls.canister_principal,
                    scan,
                    IcpAllowances.DEFAULT_TAKE,
                )) {
                    case (#err(error)) break pages (#err(error));
                    case (#ok(value)) value;
                };
                let page = switch (IcpAllowances.decodeAllowances(
                    await* calls.call(request),
                    calls.canister_principal,
                    scan,
                    IcpAllowances.DEFAULT_TAKE,
                    now,
                )) {
                    case (#err(error)) break pages (#err(error));
                    case (#ok(value)) value;
                };
                switch (IcpAllowances.findAllowance(page, spender)) {
                    case (#err(error)) break pages (#err(error));
                    case (#ok(?allowance)) break pages (#ok(?{
                        amount = allowance.allowance;
                        expires_at = allowance.expires_at;
                    }));
                    case (#ok(null)) {};
                };
                if (page.complete) break pages (#ok(null));
                scan := page.scan;
            };
        };

        func revokeReview(
            metadata : FundingMetadata,
            current : CurrentApproval,
        ) : CommandMemory.ReviewFacts {
            {
                token_name = metadata.name;
                token_symbol = metadata.symbol;
                decimals = metadata.decimals;
                fee = metadata.fee;
                transfer_fee = null;
                current_allowance = ?current.amount;
                current_expires_at = current.expires_at;
                allowance = ?0;
                total_debit = metadata.fee;
                expires_at = null;
            };
        };

        // Existing ledger approvals may name any structurally valid Account.
        // Destination admission below is deliberately stricter for new funds.
        func canonicalIcrcAccount(
            account : IcrcTypes.Account,
        ) : IcrcTypes.Result<IcrcTypes.Account> {
            let ?canonical = AllowanceAccount.canonical(account) else {
                return #err("ICRC account subaccount must be exactly 32 bytes");
            };
            #ok(canonical);
        };

        func canonicalFundingAccount(
            account : IcrcTypes.Account,
        ) : IcrcTypes.Result<IcrcTypes.Account> {
            let canonical = switch (canonicalIcrcAccount(account)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (Principal.isAnonymous(canonical.owner)) {
                return #err("Anonymous principal is not a funding account");
            };
            if (Principal.toText(canonical.owner) == "aaaaa-aa") {
                return #err("Management canister is not a funding account");
            };
            #ok(canonical);
        };

        func canonicalAllowanceSpender(
            account : IcrcTypes.Account,
        ) : IcrcTypes.Result<IcrcTypes.Account> {
            let spender = switch (canonicalFundingAccount(account)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (AllowanceAccount.isDefaultFor(spender, calls.canister_principal)) {
                return #err(
                    "Wallet default account cannot be its own allowance spender"
                );
            };
            #ok(spender);
        };

        func selectedLedger(ledger : Principal) : IcrcTypes.Result<Memory.Ledger> {
            switch (Map.get(mem.ledgers, Principal.compare, ledger)) {
                case (?value) {
                    if (value.enabled) #ok(value) else {
                        #err("Ledger is not selected in Wallet");
                    };
                };
                case null #err("Ledger is not selected in Wallet");
            };
        };

        func validateFundingDispatchAuthority(
            command : CommandMemory.Command,
        ) : IcrcTypes.Result<()> {
            if (not FundingJournal.requiresCurrentAuthority(command)) return #ok(());
            switch (selectedLedger(command.ledger)) {
                case (#err(error)) #err(error);
                case (#ok(_)) #ok(());
            };
        };

        func isIcpLedger(ledger : Principal) : Bool {
            switch (Catalog.find(ledger)) {
                case (?value) value.history_kind == #icp;
                case null false;
            };
        };

        func executeFundingCommand(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
        ) : async* WalletFundingExecutionResultV1 {
            let metadata = switch (await* readFundingMetadata(command.ledger)) {
                case (#err(error)) {
                    return rejectOrKeepPending(key, command, "metadata", error);
                };
                case (#ok(value)) value;
            };
            let expired = nowNanos() > command.valid_until;
            if (expired and command.call_args == null) {
                return rejectFundingCommand(
                    key,
                    command,
                    "expired",
                    "Wallet funding command expired before dispatch",
                );
            };
            if (not fundingMetadataMatches(command.review, metadata)) {
                return rejectOrKeepPending(
                    key,
                    command,
                    "review_changed",
                    "Ledger metadata or fee changed; prepare a new Wallet review",
                );
            };

            switch (command.operation) {
                case (#transfer(value)) {
                    if (expired) {
                        return keepFundingPending(
                            key,
                            command,
                            "expired_after_dispatch",
                            "Transfer outcome remains unknown after the command deadline",
                        );
                    };
                    await* executeFundingTransfer(key, command, value, metadata);
                };
                case (#approve(value)) {
                    await* executeFundingApproval(key, command, value, metadata);
                };
                case (#revoke(value)) switch (value.spender) {
                    case (#icrc(spender)) {
                        await* executeIcrcRevoke(key, command, value, spender, metadata);
                    };
                    case (#icp_account_identifier(spender)) {
                        await* executeIcpRevoke(key, command, value, spender, metadata);
                    };
                };
            };
        };

        func allocateFundingCreatedAt() : Nat64 {
            let now = nowNanos();
            let next = (if (now > transferMem.last_funding_created_at) now else transferMem.last_funding_created_at) + 1;
            // Persist synchronously with the subsequently frozen call_args,
            // before any value-moving await. Replays skip this allocation.
            transferMem.last_funding_created_at := next;
            next;
        };

        func executeFundingTransfer(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
            operation : {
                to : CommandMemory.Account;
                amount : Nat;
                memo : ?Blob;
            },
            metadata : FundingMetadata,
        ) : async* WalletFundingExecutionResultV1 {
            switch (validateFundingDispatchAuthority(command)) {
                case (#err(error)) {
                    return rejectFundingCommand(key, command, "ledger_deselected", error);
                };
                case (#ok(())) {};
            };
            let replay = command.call_args != null;
            let exactArgs = switch (command.call_args) {
                case (?value) value;
                case null {
                    let args : IcrcTypes.TransferArg = {
                        from_subaccount = null;
                        to = operation.to;
                        amount = operation.amount;
                        fee = ?metadata.fee;
                        memo = operation.memo;
                        created_at_time = ?allocateFundingCreatedAt();
                    };
                    let value = to_candid (args);
                    if (not freezeFundingArgs(command, value)) {
                        return rejectFundingCommand(
                            key,
                            command,
                            "argument_limit",
                            "Ledger transfer arguments exceed the Wallet limit",
                        );
                    };
                    value;
                };
            };
            switch (await* Icrc.executeTransferCandid(
                calls,
                command.ledger,
                exactArgs,
            )) {
                case (#unknown(error)) keepFundingPending(key, command, "outcome_unknown", error);
                case (#rejected(error)) {
                    if (replay) {
                        keepFundingPending(key, command, "replay_rejected", error);
                    } else {
                        rejectFundingCommand(key, command, "ledger_rejected", error);
                    };
                };
                case (#ok(receipt)) {
                    if (not FundingDisplay.nat(receipt.block_index)) {
                        return keepFundingPending(
                            key,
                            command,
                            "invalid_receipt",
                            "Ledger block index exceeds the Wallet protocol limit",
                        );
                    };
                    succeedFundingCommand(
                        command,
                        ?receipt.block_index,
                        receipt.duplicate,
                    );
                    ignore history.recordTransfer(
                        command.ledger,
                        receipt.block_index,
                        #transfer,
                        operation.amount,
                        ?metadata.fee,
                        ?#icrc(operation.to),
                        operation.memo,
                        null,
                        null,
                    );
                    invalidateLedgerBalance(command.ledger, metadata.fee);
                    fundingExecution(key, command);
                };
            };
        };

        func executeFundingApproval(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
            operation : {
                spender : CommandMemory.Account;
                amount : Nat;
                expected_allowance : Nat;
                expected_expires_at : ?Nat64;
                expires_at : Nat64;
            },
            metadata : FundingMetadata,
        ) : async* WalletFundingExecutionResultV1 {
            if (TransferJournal.allowanceReserved(transferMem, command.ledger, operation.spender.owner, null)) {
                return keepFundingPending(key, command, "withdrawal_pending", "An unresolved withdrawal uses this minter allowance; reconcile it before replacing the allowance");
            };
            let current = switch (await* readIcrcAllowance(command.ledger, operation.spender)) {
                case (#err(error)) {
                    return rejectOrKeepPending(key, command, "allowance_read", error);
                };
                case (#ok(value)) value;
            };
            switch (validateFundingDispatchAuthority(command)) {
                case (#err(error)) {
                    return rejectFundingCommand(key, command, "ledger_deselected", error);
                };
                case (#ok(())) {};
            };
            let desired = switch (command.review.allowance) {
                case null return rejectOrKeepPending(
                    key,
                    command,
                    "invalid_command",
                    "Prepared approval is missing its allowance",
                );
                case (?value) value;
            };
            if (current.amount == desired and current.expires_at == ?operation.expires_at) {
                succeedFundingCommand(command, null, false);
                invalidateLedgerBalance(command.ledger, metadata.fee);
                return fundingExecution(key, command);
            };
            if (
                current.amount != operation.expected_allowance or
                current.expires_at != operation.expected_expires_at
            ) {
                if (command.call_args != null) {
                    return keepFundingPending(
                        key,
                        command,
                        "allowance_changed_after_dispatch",
                        "Allowance changed after an unknown approval outcome; Wallet will not regrant it",
                    );
                };
                return rejectFundingCommand(
                    key,
                    command,
                    "allowance_changed",
                    "Allowance changed; prepare a new Wallet review",
                );
            };
            if (operation.expires_at <= nowNanos()) {
                return rejectOrKeepPending(
                    key,
                    command,
                    "expired",
                    "Prepared allowance expired before dispatch",
                );
            };
            if (nowNanos() > command.valid_until) {
                return rejectOrKeepPending(
                    key,
                    command,
                    "expired_after_dispatch",
                    "Approval outcome remains unknown after the command deadline",
                );
            };
            let replay = command.call_args != null;
            let exactArgs = switch (command.call_args) {
                case (?value) value;
                case null {
                    let args : IcrcTypes.ApproveArg = {
                        from_subaccount = null;
                        spender = operation.spender;
                        amount = desired;
                        expected_allowance = ?operation.expected_allowance;
                        expires_at = ?operation.expires_at;
                        fee = ?metadata.fee;
                        memo = null;
                        created_at_time = ?allocateFundingCreatedAt();
                    };
                    let value = to_candid (args);
                    if (not freezeFundingArgs(command, value)) {
                        return rejectFundingCommand(
                            key,
                            command,
                            "argument_limit",
                            "Ledger approval arguments exceed the Wallet limit",
                        );
                    };
                    value;
                };
            };
            switch (await* Icrc.executeApproveCandid(calls, command.ledger, exactArgs)) {
                case (#unknown(error)) keepFundingPending(key, command, "outcome_unknown", error);
                case (#rejected(error)) {
                    if (replay) {
                        keepFundingPending(key, command, "replay_rejected", error);
                    } else {
                        rejectFundingCommand(key, command, "ledger_rejected", error);
                    };
                };
                case (#ok(receipt)) {
                    if (not FundingDisplay.nat(receipt.block_index)) {
                        return keepFundingPending(
                            key,
                            command,
                            "invalid_receipt",
                            "Ledger block index exceeds the Wallet protocol limit",
                        );
                    };
                    succeedFundingCommand(
                        command,
                        ?receipt.block_index,
                        receipt.duplicate,
                    );
                    ignore history.recordApproval(
                        command.ledger,
                        receipt.block_index,
                        desired,
                        metadata.fee,
                        #icrc(operation.spender),
                        null,
                    );
                    invalidateLedgerBalance(command.ledger, metadata.fee);
                    fundingExecution(key, command);
                };
            };
        };

        func executeIcrcRevoke(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
            operation : {
                spender : CommandMemory.ApprovalSpender;
                expected_allowance : Nat;
                expected_expires_at : ?Nat64;
            },
            spender : CommandMemory.Account,
            metadata : FundingMetadata,
        ) : async* WalletFundingExecutionResultV1 {
            let current = switch (await* readIcrcAllowance(command.ledger, spender)) {
                case (#err(error)) {
                    return rejectOrKeepPending(key, command, "allowance_read", error);
                };
                case (#ok(value)) value;
            };
            switch (validateFundingDispatchAuthority(command)) {
                case (#err(error)) {
                    return rejectFundingCommand(key, command, "ledger_deselected", error);
                };
                case (#ok(())) {};
            };
            if (current.amount == 0) {
                succeedFundingCommand(command, null, false);
                invalidateLedgerBalance(command.ledger, metadata.fee);
                return fundingExecution(key, command);
            };
            if (
                current.amount != operation.expected_allowance or
                current.expires_at != operation.expected_expires_at
            ) {
                if (command.call_args != null) {
                    return keepFundingPending(
                        key,
                        command,
                        "allowance_changed_after_dispatch",
                        "Allowance changed after an unknown revoke outcome; Wallet will not overwrite it",
                    );
                };
                return rejectFundingCommand(
                    key,
                    command,
                    "allowance_changed",
                    "Allowance changed; refresh Wallet approvals",
                );
            };
            if (nowNanos() > command.valid_until) {
                return rejectOrKeepPending(
                    key,
                    command,
                    "expired_after_dispatch",
                    "Revoke outcome remains unknown after the command deadline",
                );
            };
            let replay = command.call_args != null;
            let exactArgs = switch (command.call_args) {
                case (?value) value;
                case null {
                    let args : IcrcTypes.ApproveArg = {
                        from_subaccount = null;
                        spender;
                        amount = 0;
                        expected_allowance = ?operation.expected_allowance;
                        expires_at = null;
                        fee = ?metadata.fee;
                        memo = null;
                        created_at_time = ?allocateFundingCreatedAt();
                    };
                    let value = to_candid (args);
                    if (not freezeFundingArgs(command, value)) {
                        return rejectFundingCommand(
                            key,
                            command,
                            "argument_limit",
                            "Ledger revoke arguments exceed the Wallet limit",
                        );
                    };
                    value;
                };
            };
            switch (await* Icrc.executeApproveCandid(calls, command.ledger, exactArgs)) {
                case (#unknown(error)) keepFundingPending(key, command, "outcome_unknown", error);
                case (#rejected(error)) {
                    if (replay) {
                        keepFundingPending(key, command, "replay_rejected", error);
                    } else {
                        rejectFundingCommand(key, command, "ledger_rejected", error);
                    };
                };
                case (#ok(receipt)) {
                    if (not FundingDisplay.nat(receipt.block_index)) {
                        return keepFundingPending(
                            key,
                            command,
                            "invalid_receipt",
                            "Ledger block index exceeds the Wallet protocol limit",
                        );
                    };
                    succeedFundingCommand(
                        command,
                        ?receipt.block_index,
                        receipt.duplicate,
                    );
                    ignore history.recordApproval(
                        command.ledger,
                        receipt.block_index,
                        0,
                        metadata.fee,
                        #icrc(spender),
                        null,
                    );
                    invalidateLedgerBalance(command.ledger, metadata.fee);
                    fundingExecution(key, command);
                };
            };
        };

        func executeIcpRevoke(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
            operation : {
                spender : CommandMemory.ApprovalSpender;
                expected_allowance : Nat;
                expected_expires_at : ?Nat64;
            },
            spender : Blob,
            metadata : FundingMetadata,
        ) : async* WalletFundingExecutionResultV1 {
            let current = switch (await* findIcpAllowance(
                command.ledger,
                spender,
                nowNanos(),
            )) {
                case (#err(error)) {
                    return rejectOrKeepPending(key, command, "allowance_read", error);
                };
                case (#ok(value)) value;
            };
            switch (validateFundingDispatchAuthority(command)) {
                case (#err(error)) {
                    return rejectFundingCommand(key, command, "ledger_deselected", error);
                };
                case (#ok(())) {};
            };
            switch (current) {
                case null {
                    succeedFundingCommand(command, null, false);
                    invalidateLedgerBalance(command.ledger, metadata.fee);
                    return fundingExecution(key, command);
                };
                case (?value) {
                    if (
                        value.amount != operation.expected_allowance or
                        value.expires_at != operation.expected_expires_at
                    ) {
                        if (command.call_args != null) {
                            return keepFundingPending(
                                key,
                                command,
                                "allowance_changed_after_dispatch",
                                "ICP approval changed after an unknown revoke outcome",
                            );
                        };
                        return rejectFundingCommand(
                            key,
                            command,
                            "allowance_changed",
                            "ICP approval changed; refresh Wallet approvals",
                        );
                    };
                };
            };
            if (nowNanos() > command.valid_until) {
                return rejectOrKeepPending(
                    key,
                    command,
                    "expired_after_dispatch",
                    "ICP revoke deadline passed before dispatch",
                );
            };
            // ICP remove_approval has no timestamp or CAS. Once exact args may
            // have been dispatched, only disappearance reconciles success;
            // never issue a second fee-bearing removal automatically.
            switch (command.call_args) {
                case (?_) return keepFundingPending(
                    key,
                    command,
                    "outcome_unknown",
                    "ICP approval still exists after an unknown revoke outcome; Wallet will not retry it",
                );
                case null {};
            };
            let request = switch (IcpAllowances.removeApprovalRequest(
                command.ledger,
                spender,
                ?metadata.fee,
            )) {
                case (#err(error)) return rejectFundingCommand(
                    key,
                    command,
                    "invalid_command",
                    error,
                );
                case (#ok(value)) value;
            };
            if (not freezeFundingArgs(command, request.args)) {
                return rejectFundingCommand(
                    key,
                    command,
                    "argument_limit",
                    "ICP revoke arguments exceed the Wallet limit",
                );
            };
            switch (Icrc.classifyApproveResult(await* calls.call(request))) {
                case (#unknown(error)) keepFundingPending(key, command, "outcome_unknown", error);
                case (#rejected(error)) rejectFundingCommand(
                    key,
                    command,
                    "ledger_rejected",
                    error,
                );
                case (#ok(receipt)) {
                    if (not FundingDisplay.nat(receipt.block_index)) {
                        return keepFundingPending(
                            key,
                            command,
                            "invalid_receipt",
                            "Ledger block index exceeds the Wallet protocol limit",
                        );
                    };
                    succeedFundingCommand(
                        command,
                        ?receipt.block_index,
                        receipt.duplicate,
                    );
                    ignore history.recordApproval(
                        command.ledger,
                        receipt.block_index,
                        0,
                        metadata.fee,
                        #icp_account_identifier(spender),
                        null,
                    );
                    invalidateLedgerBalance(command.ledger, metadata.fee);
                    fundingExecution(key, command);
                };
            };
        };

        func freezeFundingArgs(
            command : CommandMemory.Command,
            args : Blob,
        ) : Bool {
            if (args.size() > MAX_FUNDING_CALL_ARGS_BYTES) return false;
            switch (command.call_args) {
                case null command.call_args := ?args;
                case (?existing) {
                    // Pending commands may only reuse the exact durable bytes.
                    if (existing != args) return false;
                };
            };
            command.updated_at := Time.now();
            true;
        };

        func fundingMetadataMatches(
            review : CommandMemory.ReviewFacts,
            metadata : FundingMetadata,
        ) : Bool {
            review.token_name == metadata.name and
            review.token_symbol == metadata.symbol and
            review.decimals == metadata.decimals and
            review.fee == metadata.fee and (
            switch (review.transfer_fee) {
                case null true;
                case (?value) value == metadata.fee;
            });
        };

        func rejectOrKeepPending(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
            code : Text,
            message : Text,
        ) : WalletFundingExecutionResultV1 {
            if (command.call_args == null) {
                rejectFundingCommand(key, command, code, message);
            } else {
                keepFundingPending(key, command, code, message);
            };
        };

        func rejectFundingCommand(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
            code : Text,
            message : Text,
        ) : WalletFundingExecutionResultV1 {
            switch (command.status) {
                case (#succeeded(_)) return fundingExecution(key, command);
                case (#rejected(_)) return fundingExecution(key, command);
                case (_) {};
            };
            let error = commandError(code, message);
            command.status := #rejected(error);
            command.updated_at := Time.now();
            fundingExecution(key, command);
        };

        func keepFundingPending(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
            code : Text,
            message : Text,
        ) : WalletFundingExecutionResultV1 {
            switch (command.status) {
                case (#succeeded(_)) return fundingExecution(key, command);
                case (#rejected(_)) return fundingExecution(key, command);
                case (_) {};
            };
            let previous = switch (command.status) {
                case (#pending(value)) value;
                case (_) {
                    {
                        attempts = 1;
                        started_at = Time.now();
                        last_error = null;
                    };
                };
            };
            command.status := #pending({
                attempts = previous.attempts;
                started_at = previous.started_at;
                last_error = ?commandError(code, message);
            });
            command.updated_at := Time.now();
            fundingExecution(key, command);
        };

        func succeedFundingCommand(
            command : CommandMemory.Command,
            blockIndex : ?Nat,
            duplicate : Bool,
        ) : () {
            command.status := #succeeded({
                block_index = blockIndex;
                duplicate;
                completed_at = Time.now();
            });
            command.updated_at := Time.now();
        };

        func commandError(code : Text, message : Text) : CommandMemory.CommandError {
            {
                code = boundedText(code, 64);
                message = boundedText(message, 512);
                at = Time.now();
            };
        };

        func commandId(key : CommandMemory.CommandKey) : WalletFundingCommandIdV1 {
            {
                caller_app_id = key.caller_app_id;
                request_id = key.request_id;
            };
        };

        func fundingExecution(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
        ) : WalletFundingExecutionResultV1 {
            let id = commandId(key);
            switch (command.status) {
                case (#prepared) pendingExecution(id, "Wallet funding command is prepared");
                case (#pending(value)) {
                    let message = switch (value.last_error) {
                        case (?error) error.message;
                        case null "Wallet funding command is in progress";
                    };
                    pendingExecution(id, message);
                };
                case (#rejected(error)) rejectedExecution(id, error.message);
                case (#succeeded(receipt)) switch (command.operation) {
                    case (#transfer(_)) switch (receipt.block_index) {
                        case (?blockIndex) #transferred({
                            command_id = id;
                            block_index = blockIndex;
                            duplicate = receipt.duplicate;
                        });
                        case null pendingExecution(
                            id,
                            "Transfer receipt is awaiting ledger reconciliation",
                        );
                    };
                    case (#approve(_)) #approved({
                        command_id = id;
                        block_index = receipt.block_index;
                        duplicate = receipt.duplicate;
                    });
                    case (#revoke(_)) #revoked({
                        command_id = id;
                        block_index = receipt.block_index;
                        duplicate = receipt.duplicate;
                    });
                };
            };
        };

        func pendingExecution(
            id : WalletFundingCommandIdV1,
            message : Text,
        ) : WalletFundingExecutionResultV1 {
            #pending({ command_id = id; message = boundedText(message, 512) });
        };

        func rejectedExecution(
            id : WalletFundingCommandIdV1,
            message : Text,
        ) : WalletFundingExecutionResultV1 {
            #rejected({ command_id = id; message = boundedText(message, 512) });
        };

        func fundingReview(
            key : CommandMemory.CommandKey,
            command : CommandMemory.Command,
        ) : WalletFundingReviewV1 {
            let common = command.review;
            switch (command.operation) {
                case (#transfer(value)) {
                    {
                        command_id = commandId(key);
                        kind = #direct;
                        ledger = command.ledger;
                        token_name = common.token_name;
                        token_symbol = common.token_symbol;
                        decimals = common.decimals;
                        amount_atoms = value.amount;
                        transfer_fee_atoms = ?common.fee;
                        approval_fee_atoms = null;
                        allowance_atoms = null;
                        current_allowance_atoms = null;
                        current_expires_at_ns = null;
                        total_debit_atoms = common.total_debit;
                        destination = ?value.to;
                        spender = null;
                        memo = value.memo;
                        valid_until_ns = command.valid_until;
                        expires_at_ns = null;
                    };
                };
                case (#approve(value)) {
                    {
                        command_id = commandId(key);
                        kind = #allowance;
                        ledger = command.ledger;
                        token_name = common.token_name;
                        token_symbol = common.token_symbol;
                        decimals = common.decimals;
                        amount_atoms = value.amount;
                        transfer_fee_atoms = common.transfer_fee;
                        approval_fee_atoms = ?common.fee;
                        allowance_atoms = common.allowance;
                        current_allowance_atoms = common.current_allowance;
                        current_expires_at_ns = common.current_expires_at;
                        total_debit_atoms = common.total_debit;
                        destination = null;
                        spender = ?#icrc(value.spender);
                        memo = null;
                        valid_until_ns = command.valid_until;
                        expires_at_ns = common.expires_at;
                    };
                };
                case (#revoke(value)) {
                    {
                        command_id = commandId(key);
                        kind = #revoke;
                        ledger = command.ledger;
                        token_name = common.token_name;
                        token_symbol = common.token_symbol;
                        decimals = common.decimals;
                        amount_atoms = value.expected_allowance;
                        transfer_fee_atoms = null;
                        approval_fee_atoms = ?common.fee;
                        allowance_atoms = common.allowance;
                        current_allowance_atoms = common.current_allowance;
                        current_expires_at_ns = common.current_expires_at;
                        total_debit_atoms = common.total_debit;
                        destination = null;
                        spender = ?value.spender;
                        memo = null;
                        valid_until_ns = command.valid_until;
                        expires_at_ns = null;
                    };
                };
            };
        };

        func invalidateLedgerBalance(ledger : Principal, fee : Nat) : () {
            mem.balance_epoch += 1;
            let ?current = Map.get(mem.ledgers, Principal.compare, ledger) else return;
            Map.add(mem.ledgers, Principal.compare, ledger, {
                current with
                fee = ?fee;
                balance_error = null;
            });
        };

        public func /*update*/wallet_allowances_page_v1(
            request : WalletAllowancesPageRequestV1,
        ) : async* WalletAllowancesPageResultV1 {
            if (request.limit == 0 or request.limit > MAX_ALLOWANCE_PAGE_SIZE) {
                return #err("Allowance page size is outside the Wallet limit");
            };
            switch (selectedLedger(request.ledger)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            if (
                not calls.can_call(request.ledger, "icrc1_metadata") or
                not calls.can_call(request.ledger, "icrc1_fee")
            ) {
                return #err("Ledger metadata access is not reserved for Wallet");
            };
            let metadata = switch (await* readFundingMetadata(request.ledger)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (isIcpLedger(request.ledger)) {
                await* icpAllowancesPage(request, metadata);
            } else {
                await* icrcAllowancesPage(request, metadata);
            };
        };

        func tokenInfoPreview(
            request : WalletTokenInfoPreviewRequestV1,
        ) : WalletTokenInfoResultV1 {
            switch (selectedLedger(request.ledger)) { case (#err(error)) return #err(error); case (_) {} };
            if (request.owner != calls.canister_principal) return #err("Wallet token information belongs to another account");
            if (not calls.can_call(request.ledger, "icrc1_metadata") or not calls.can_call(request.ledger, "icrc1_fee") or not calls.can_call(request.ledger, "icrc1_balance_of")) {
                return #err("Ledger token information is not reserved for Wallet");
            };
            let metadata = switch (decodeFundingMetadata(#ok(to_candid(request.metadata)), #ok(to_candid(request.fee)))) {
                case (#err(error)) return #err(error); case (#ok(value)) value;
            };
            if (not FundingDisplay.nat(request.balance)) return #err("Wallet balance exceeds the Wallet protocol limit");
            #ok({
                ledger = request.ledger;
                account = { owner = calls.canister_principal; subaccount = null };
                token_name = metadata.name; token_symbol = metadata.symbol; decimals = metadata.decimals;
                fee_atoms = metadata.fee; balance_atoms = request.balance; observed_at_ns = nowNanos();
            });
        };

        public func /*update*/wallet_token_info_v1(
            request : WalletTokenInfoRequestV1,
        ) : async* WalletTokenInfoResultV1 {
            switch (selectedLedger(request.ledger)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            if (
                not calls.can_call(request.ledger, "icrc1_metadata") or
                not calls.can_call(request.ledger, "icrc1_fee") or
                not calls.can_call(request.ledger, "icrc1_balance_of")
            ) {
                return #err("Ledger token information is not reserved for Wallet");
            };
            let replies = await* calls.call_batch([
                Icrc.metadataRequest(request.ledger),
                Icrc.feeRequest(request.ledger),
                Icrc.balanceRequest(request.ledger, calls.canister_principal),
            ]);
            if (replies.size() != 3) {
                return #err("Wallet backend returned an incomplete token information batch");
            };
            let metadata = switch (decodeFundingMetadata(replies[0], replies[1])) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let balance = switch (Icrc.decodeBalance(replies[2])) {
                case (#err(error)) return #err("Could not read the Wallet balance: " # error);
                case (#ok(value)) value;
            };
            if (not FundingDisplay.nat(balance)) {
                return #err("Wallet balance exceeds the Wallet protocol limit");
            };
            switch (selectedLedger(request.ledger)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            #ok({
                ledger = request.ledger;
                account = {
                    owner = calls.canister_principal;
                    subaccount = null;
                };
                token_name = metadata.name;
                token_symbol = metadata.symbol;
                decimals = metadata.decimals;
                fee_atoms = metadata.fee;
                balance_atoms = balance;
                observed_at_ns = nowNanos();
            });
        };

        func icrcAllowancesPage(
            request : WalletAllowancesPageRequestV1,
            metadata : FundingMetadata,
        ) : async* WalletAllowancesPageResultV1 {
            let scan = switch (icrcAllowanceScan(request.cursor)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (
                not calls.can_call(request.ledger, "icrc103_get_allowances") or
                not calls.can_call(request.ledger, "icrc2_allowance") or
                not calls.can_call(request.ledger, "icrc2_approve")
            ) {
                return #ok(emptyAllowancesPage(
                    request.ledger,
                    metadata,
                    #icrc103,
                    #permission_required,
                    ?"The complete ICRC allowance review and revoke route is not reserved for Wallet",
                ));
            };
            let call = switch (Icrc103.getAllowancesRequest(
                request.ledger,
                calls.canister_principal,
                scan,
                request.limit,
            )) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let raw = await* calls.call(call);
            let page = switch (Icrc103.decodeAllowances(
                raw,
                calls.canister_principal,
                scan,
                request.limit,
                nowNanos(),
            )) {
                case (#err(error)) {
                    return #ok(emptyAllowancesPage(
                        request.ledger,
                        metadata,
                        #icrc103,
                        #degraded(error),
                        ?error,
                    ));
                };
                case (#ok(value)) value;
            };
            for (allowance in page.allowances.vals()) {
                if (not FundingDisplay.nat(allowance.allowance)) {
                    let error = "Ledger allowance exceeds the Wallet protocol limit";
                    return #ok(emptyAllowancesPage(
                        request.ledger,
                        metadata,
                        #icrc103,
                        #degraded(error),
                        ?error,
                    ));
                };
            };
            let entries = Array.map<Icrc103.Allowance, WalletAllowanceEntryV1>(
                page.allowances,
                func(allowance) {
                    {
                        spender = #icrc(allowance.to_spender);
                        amount_atoms = allowance.allowance;
                        expires_at_ns = allowance.expires_at;
                    };
                },
            );
            let capped = not page.complete and (
                page.scan.pages >= Icrc103.MAX_SCAN_PAGES or
                page.scan.entries >= Icrc103.MAX_SCAN_ENTRIES
            );
            let next : ?WalletAllowanceCursorV1 = if (page.complete or capped) null else {
                switch (page.scan.cursor) {
                    case null null;
                    case (?cursor) ?#icrc103({
                        from_account = cursor.from_account;
                        to_spender = cursor.prev_spender;
                        pages = page.scan.pages;
                        entries = page.scan.entries;
                    });
                };
            };
            #ok({
                ledger = request.ledger;
                token_name = metadata.name;
                token_symbol = metadata.symbol;
                decimals = metadata.decimals;
                revoke_fee_atoms = ?metadata.fee;
                source = #icrc103;
                state = if (capped) {
                    #degraded("ICRC-103 allowance scan reached the Wallet limit");
                } else #ready;
                entries;
                next;
                has_more = next != null;
                warning = if (capped) {
                    ?"Additional allowances may exist beyond the Wallet scan limit";
                } else null;
            });
        };

        func icpAllowancesPage(
            request : WalletAllowancesPageRequestV1,
            metadata : FundingMetadata,
        ) : async* WalletAllowancesPageResultV1 {
            let scan = switch (icpAllowanceScan(request.cursor)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (
                not calls.can_call(request.ledger, "get_allowances") or
                not calls.can_call(request.ledger, "remove_approval")
            ) {
                return #ok(emptyAllowancesPage(
                    request.ledger,
                    metadata,
                    #icp,
                    #permission_required,
                    ?"The complete ICP approval review and revoke route is not reserved for Wallet",
                ));
            };
            let reconciled = await* reconcilePendingIcpRevokes(
                request.ledger,
                nowNanos(),
            );
            if (reconciled > 0) {
                invalidateLedgerBalance(request.ledger, metadata.fee);
            };
            let call = switch (IcpAllowances.getAllowancesRequest(
                request.ledger,
                calls.canister_principal,
                scan,
                request.limit,
            )) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let raw = await* calls.call(call);
            let page = switch (IcpAllowances.decodeAllowances(
                raw,
                calls.canister_principal,
                scan,
                request.limit,
                nowNanos(),
            )) {
                case (#err(error)) {
                    return #ok(emptyAllowancesPage(
                        request.ledger,
                        metadata,
                        #icp,
                        #degraded(error),
                        ?error,
                    ));
                };
                case (#ok(value)) value;
            };
            let entries = Array.map<IcpAllowances.Allowance, WalletAllowanceEntryV1>(
                page.allowances,
                func(allowance) {
                    {
                        spender = #icp_account_identifier(allowance.to_spender_id);
                        amount_atoms = allowance.allowance;
                        expires_at_ns = allowance.expires_at;
                    };
                },
            );
            let capped = not page.complete and (
                page.scan.pages >= IcpAllowances.MAX_SCAN_PAGES or
                page.scan.entries >= IcpAllowances.MAX_SCAN_ENTRIES
            );
            let next : ?WalletAllowanceCursorV1 = if (page.complete or capped) null else {
                switch (page.scan.cursor) {
                    case null null;
                    case (?cursor) ?#icp({
                        from_account_id = cursor.from_account_id;
                        prev_spender_id = cursor.prev_spender_id;
                        pages = page.scan.pages;
                        entries = page.scan.entries;
                    });
                };
            };
            #ok({
                ledger = request.ledger;
                token_name = metadata.name;
                token_symbol = metadata.symbol;
                decimals = metadata.decimals;
                revoke_fee_atoms = ?metadata.fee;
                source = #icp;
                state = if (capped) {
                    #degraded("ICP allowance scan reached the Wallet limit");
                } else #ready;
                entries;
                next;
                has_more = next != null;
                warning = if (capped) {
                    ?"Additional ICP approvals may exist beyond the Wallet scan limit";
                } else null;
            });
        };

        // Legacy remove_approval has no replay-safe timestamp. Loading the ICP
        // approvals view opportunistically resolves lost replies with one
        // bounded read-only scan from the beginning. Partial scans never prove
        // absence, and eligibility is snapshotted before the first await.
        func reconcilePendingIcpRevokes(
            ledger : Principal,
            observedAt : Nat64,
        ) : async* Nat {
            let candidates = FundingJournal.snapshotPendingIcpRevokes(
                commandMem.commands,
                ledger,
            );
            if (candidates.size() == 0) return 0;

            var scan = IcpAllowances.startScan();
            label pages : Nat loop {
                let request = switch (IcpAllowances.getAllowancesRequest(
                    ledger,
                    calls.canister_principal,
                    scan,
                    IcpAllowances.MAX_PAGE_ENTRIES,
                )) {
                    case (#err(_)) break pages 0;
                    case (#ok(value)) value;
                };
                let page = switch (IcpAllowances.decodeAllowances(
                    await* calls.call(request),
                    calls.canister_principal,
                    scan,
                    IcpAllowances.MAX_PAGE_ENTRIES,
                    observedAt,
                )) {
                    case (#err(_)) break pages 0;
                    case (#ok(value)) value;
                };
                for (allowance in page.allowances.vals()) {
                    FundingJournal.noteIcpSpender(
                        candidates,
                        allowance.to_spender_id,
                    );
                };
                if (page.complete) {
                    let reconciled = FundingJournal.reconcileIcpCompleteScan(
                        candidates,
                        ledger,
                        Time.now(),
                    );
                    break pages reconciled;
                };
                scan := page.scan;
            };
        };

        func icrcAllowanceScan(
            cursor : ?WalletAllowanceCursorV1,
        ) : IcrcTypes.Result<Icrc103.Scan> {
            switch (cursor) {
                case null #ok(Icrc103.startScan());
                case (?#icrc103(value)) {
                    if (value.pages == 0 or value.entries == 0) {
                        return #err("Invalid ICRC-103 allowance cursor counters");
                    };
                    #ok({
                        cursor = ?{
                            from_account = value.from_account;
                            prev_spender = value.to_spender;
                        };
                        pages = value.pages;
                        entries = value.entries;
                    });
                };
                case (_) #err("Allowance cursor does not match this ICRC ledger");
            };
        };

        func icpAllowanceScan(
            cursor : ?WalletAllowanceCursorV1,
        ) : IcrcTypes.Result<IcpAllowances.Scan> {
            switch (cursor) {
                case null #ok(IcpAllowances.startScan());
                case (?#icp(value)) {
                    if (value.pages == 0 or value.entries == 0) {
                        return #err("Invalid ICP allowance cursor counters");
                    };
                    #ok({
                        cursor = ?{
                            from_account_id = value.from_account_id;
                            prev_spender_id = value.prev_spender_id;
                        };
                        pages = value.pages;
                        entries = value.entries;
                    });
                };
                case (_) #err("Allowance cursor does not match the ICP ledger");
            };
        };

        func emptyAllowancesPage(
            ledger : Principal,
            metadata : FundingMetadata,
            source : WalletAllowanceSourceV1,
            state : WalletAllowancesStateV1,
            warning : ?Text,
        ) : WalletAllowancesPageV1 {
            {
                ledger;
                token_name = metadata.name;
                token_symbol = metadata.symbol;
                decimals = metadata.decimals;
                revoke_fee_atoms = ?metadata.fee;
                source;
                state;
                entries = [];
                next = null;
                has_more = false;
                warning;
            };
        };

        public func /*update*/wallet_add_ledger_v1(
            principal : Principal,
        ) : async* WalletSnapshot {
            switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                case (?ledger) if (ledger.enabled) return snapshot();
                case (_) {};
            };
            // Build the additive selection in the backend so callers cannot
            // replace another caller's selections with a stale snapshot.
            let principals = Array.map<Memory.Ledger, Principal>(
                enabledLedgers(),
                func(ledger) { ledger.principal },
            );
            await* wallet_set_ledgers(Array.concat(principals, [principal]));
        };

        public func /*update*/wallet_set_ledgers(
            principals : [Principal],
        ) : async* WalletSnapshot {
            if (principals.size() > MAX_SELECTED_LEDGERS) {
                Runtime.trap("Too many selected ledgers");
            };
            let requested = Set.empty<Principal>();
            var newCustomLedgers = 0;
            var index = 0;
            while (index < principals.size()) {
                let principal = principals[index];
                if (Principal.isAnonymous(principal)) {
                    Runtime.trap("Anonymous is not a ledger principal");
                };
                if (Principal.toText(principal) == "aaaaa-aa") {
                    Runtime.trap("Management canister is not a ledger principal");
                };
                if (principal == calls.canister_principal) {
                    Runtime.trap("Wallet canister is not a ledger principal");
                };
                if (not Set.insert(requested, Principal.compare, principal)) {
                    Runtime.trap("Ledger selection contains a duplicate");
                };
                if (
                    not calls.can_call(principal, "icrc1_metadata") or
                    not calls.can_call(principal, "icrc1_balance_of") or
                    not calls.can_call(principal, "icrc1_fee") or
                    not calls.can_call(principal, "icrc1_transfer")
                ) {
                    Runtime.trap("Ledger is not reserved for Wallet");
                };
                switch (Catalog.find(principal)) {
                    case null {
                        if (not calls.can_call(principal, "icrc3_get_blocks")) {
                            Runtime.trap("Ledger history access is not reserved for Wallet");
                        };
                        switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                            case null newCustomLedgers += 1;
                            case (?_) {};
                        };
                    };
                    case (?catalogLedger) {
                        switch (catalogLedger.index) {
                            case null {
                                switch (catalogLedger.history_kind) {
                                    case (#icp) Runtime.trap(
                                        "Direct ICP ledger history is not supported"
                                    );
                                    case (#icrc) {};
                                };
                                if (not calls.can_call(principal, "icrc3_get_blocks")) {
                                    Runtime.trap("Ledger history access is not reserved for Wallet");
                                };
                            };
                            case (?indexText) {
                                let indexPrincipal = Principal.fromText(indexText);
                                if (not calls.can_call(indexPrincipal, "get_account_transactions")) {
                                    Runtime.trap("Ledger index access is not reserved for Wallet");
                                };
                            };
                        };
                        switch (catalogLedger.native_route) {
                            case null {};
                            case (?route) {
                                if (not calls.can_call(principal, "icrc2_approve")) {
                                    Runtime.trap("Ledger approval access is not reserved for Wallet");
                                };
                                for (required in ChainKey.requiredCalls(route).vals()) {
                                    if (not calls.can_call(required.principal, required.method)) {
                                        Runtime.trap("Native token access is not reserved for Wallet");
                                    };
                                };
                            };
                        };
                    };
                };
                index += 1;
            };
            if (
                retainedCustomLedgerCountAfter(requested) + newCustomLedgers >
                MAX_RETAINED_CUSTOM_LEDGERS
            ) {
                Runtime.trap("Too many retained custom ledgers");
            };

            mem.metadata_epoch += 1;
            mem.balance_epoch += 1;
            mem.native_epoch += 1;
            let nativeEpoch = mem.native_epoch;
            for (principal in principals.vals()) {
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case (?ledger) setLedgerEnabled(ledger, true);
                    case null {
                        Map.add(
                            mem.ledgers,
                            Principal.compare,
                            principal,
                            newLedger(principal, Catalog.find(principal)),
                        );
                        mem.next_id += 1;
                    };
                };
            };
            let disabled = List.empty<Memory.Ledger>();
            for (ledger in Map.values(mem.ledgers)) {
                if (
                    ledger.enabled and
                    not Set.contains(requested, Principal.compare, ledger.principal)
                ) {
                    List.add(disabled, ledger);
                };
            };
            for (ledger in List.values(disabled)) {
                setLedgerEnabled(ledger, false);
            };
            discardEmptyUnselectedCustomLedgers(requested);
            mem.configured := true;

            let enabled = enabledLedgers();
            if (enabled.size() > 0) {
                ignore await* discoverNativeAddresses(
                    enabled,
                    nativeEpoch,
                );
                ignore await* refreshMetadata(enabled);
                ignore await* history.sync(true);
            };
            snapshot();
        };

        func resolveTransferDestination(
            request : WalletTransferRequest,
        ) : IcrcTypes.Result<ResolvedTransferDestination> {
            switch (Map.get(mem.ledgers, Principal.compare, request.ledger)) {
                case (?ledger) if (ledger.enabled) {};
                case (_) return #err("Ledger is not selected");
            };
            if (not supportsNetwork(request.ledger, request.network)) {
                return #err("Network is not enabled for this ledger");
            };
            if (not destinationMatchesNetwork(request.expected_destination, request.network)) {
                return #err("Approved destination does not match the selected network");
            };
            switch (appCalls.contacts.contacts_discover_v1({
                contact_id = ?request.contact_id;
                search_text = "";
                destination_kinds = [request.network];
                offset = 0;
                limit = 20;
            })) {
                case (#err(error)) #err(contactErrorText(error));
                case (#ok(page)) {
                    var found : ?ContactDestinationV1 = null;
                    for (candidate in page.destinations.vals()) {
                        if (
                            candidate.contact_id == request.contact_id and
                            candidate.address.id == request.address_id
                        ) {
                            found := ?candidate;
                        };
                    };
                    let ?candidate = found else {
                        return #err("Contact destination was not found");
                    };
                    if (candidate.contact_revision != request.contact_revision) {
                        return #err("Contact changed; review the destination again");
                    };
                    if (
                        not destinationsEqual(
                            request.expected_destination,
                            candidate.address.destination,
                        )
                    ) {
                        return #err("Contact destination no longer matches the approved destination");
                    };
                    #ok({
                        destination = candidate.address.destination;
                        contact_name = candidate.contact_name;
                        address_label = candidate.address.address_label;
                    });
                };
            };
        };

        func preflightTransfer(
            request : WalletTransferRequest,
            catalogLedger : ?Catalog.Ledger,
        ) : IcrcTypes.Result<()> {
            let ?selected = Map.get(mem.ledgers, Principal.compare, request.ledger) else {
                return #err("Ledger is not selected");
            };
            if (not selected.enabled) return #err("Ledger is not selected");
            if (selected.decimals == null) {
                return #err("Ledger token decimals are not available");
            };
            if (not calls.can_call(request.ledger, "icrc1_fee")) {
                return #err("Ledger fee access is not reserved for Wallet");
            };
            switch (request.network) {
                case (#internet_computer) {
                    if (not calls.can_call(request.ledger, "icrc1_transfer")) {
                        return #err("Ledger transfer access is not reserved for Wallet");
                    };
                };
                case (_) {
                    let ?catalog = catalogLedger else {
                        return #err("Ledger has no native withdrawal route");
                    };
                    let ?route = catalog.native_route else {
                        return #err("Ledger has no native withdrawal route");
                    };
                    if (not calls.can_call(request.ledger, "icrc2_approve")) {
                        return #err("Ledger approval access is not reserved for Wallet");
                    };
                    for (required in ChainKey.requiredCalls(route).vals()) {
                        if (not calls.can_call(required.principal, required.method)) {
                            return #err("Native withdrawal access is not reserved for Wallet");
                        };
                    };
                };
            };
            #ok(());
        };

        func validateSavedTransferDestination(
            request : WalletTransferRequest,
            expected : DestinationV1,
            binding : ?TransferDestinationBinding,
        ) : Withdrawals.Result<()> {
            switch (binding) {
                case null validateTransferDestination(request, expected);
                case (?#direct_ethereum(address)) {
                    if (not validEthereumAddress(address) or request.network != #ethereum_mainnet or expected != #ethereum_mainnet(address) or request.expected_destination != expected) return #err("Saved Ethereum destination does not match the approved withdrawal");
                    switch (selectedLedger(request.ledger)) { case (#err(error)) return #err(error); case (_) {} };
                    if (not supportsNetwork(request.ledger, #ethereum_mainnet)) return #err("Ledger has no Ethereum withdrawal route");
                    #ok(());
                };
            };
        };

        func validateTransferDestination(
            request : WalletTransferRequest,
            expected : DestinationV1,
        ) : Withdrawals.Result<()> {
            switch (resolveTransferDestination(request)) {
                case (#err(error)) #err(error);
                case (#ok(current)) {
                    if (destinationsEqual(expected, current.destination)) #ok(()) else {
                        #err("Contact destination changed before the transfer");
                    };
                };
            };
        };

        func transferSucceeded(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            fee : Nat,
            blockIndex : Nat,
            native : Bool,
            relatedLedger : ?Principal,
            relatedBlockIndex : ?Nat,
            memo : ?Blob,
        ) : () {
            let destination = switch (resolved.destination) {
                case (#internet_computer(account)) ?#icrc(account);
                case (_) null;
            };
            let intent = transferIntent(request, resolved, native);
            let nativeContext : ?Memory.NativeHistoryContext = if (native) {
                ?{
                    network = intent.network;
                    transaction_id = null;
                    output_index = null;
                    related_ledger = relatedLedger;
                    related_block_index = relatedBlockIndex;
                };
            } else null;
            ignore history.recordTransfer(
                request.ledger,
                blockIndex,
                if (native) #burn else #transfer,
                request.amount,
                if (native) null else ?fee,
                destination,
                memo,
                ?intent,
                nativeContext,
            );
            invalidateLedgerBalance(request.ledger, fee);
        };

        func recordSecondaryNativeBurn(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            asset : Withdrawals.BurnReceipt,
            gas : Withdrawals.BurnReceipt,
        ) : () {
            ensureRetainedLedger(gas.ledger);
            let intent = transferIntent(request, resolved, true);
            ignore history.recordTransfer(
                gas.ledger,
                gas.block_index,
                #burn,
                gas.amount,
                null,
                null,
                null,
                ?intent,
                ?{
                    network = intent.network;
                    transaction_id = null;
                    output_index = null;
                    related_ledger = ?asset.ledger;
                    related_block_index = ?asset.block_index;
                },
            );
        };

        func transferIntent(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            native : Bool,
        ) : Memory.TransferIntent {
            {
                contact_id = request.contact_id;
                address_id = request.address_id;
                contact_name = boundedText(resolved.contact_name, 128);
                address_label = switch (resolved.address_label) {
                    case null null;
                    case (?value) ?boundedText(value, 128);
                };
                network = Catalog.networkText(toCatalogNetwork(request.network));
                destination = boundedText(destinationText(resolved.destination), 256);
                native;
            };
        };

        func ensureRetainedLedger(principal : Principal) : () {
            switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                case (?_) return;
                case null {};
            };
            let ?catalogLedger = Catalog.find(principal) else return;
            let source : Memory.HistorySource = switch (catalogLedger.index) {
                case null #unavailable;
                case (?value) #index(Principal.fromText(value));
            };
            Map.add(mem.ledgers, Principal.compare, principal, {
                id = mem.next_id;
                principal;
                name = ?catalogLedger.name;
                symbol = ?catalogLedger.symbol;
                decimals = null;
                fee = null;
                logo = null;
                balance = null;
                metadata_updated_at = null;
                balance_updated_at = null;
                metadata_error = null;
                balance_error = null;
                native_address = null;
                native_address_updated_at = null;
                native_address_error = null;
                native_refresh_updated_at = null;
                native_refresh_error = null;
                native_deposit_progress = null;
                enabled = false;
                history = HistoryStore.emptyHistory(source);
            });
            mem.next_id += 1;
        };

        func transferReceipt(
            request : WalletTransferRequest,
            fee : Nat,
            blockIndex : Nat,
            secondaryBlockIndex : ?Nat,
            native : Bool,
            duplicate : Bool,
        ) : WalletTransferReceipt {
            {
                ledger = request.ledger;
                native;
                contact_id = request.contact_id;
                address_id = request.address_id;
                amount = request.amount;
                fee;
                block_index = blockIndex;
                secondary_block_index = secondaryBlockIndex;
                duplicate;
            };
        };

        public func /*update*/wallet_refresh_metadata(()) : async* RefreshReport {
            await* refreshMetadata(enabledLedgers());
        };

        public func /*update*/wallet_refresh_balances(()) : async* RefreshReport {
            await* refreshBalances(enabledLedgers());
        };

        public func /*update*/wallet_refresh_deposits(()) : async* DepositRefreshReport {
            mem.native_epoch += 1;
            let epoch = mem.native_epoch;
            let ledgers = enabledLedgers();
            let discovered = await* discoverNativeAddresses(ledgers, epoch);
            if (mem.native_epoch != epoch) {
                return depositReport(discovered);
            };
            let refreshed = await* refreshNativeDeposits(ledgers, epoch);
            if (mem.native_epoch == epoch) {
                ignore await* history.sync(true);
            };
            depositReport(addNativeCounts(discovered, refreshed));
        };

        func discoverNativeAddresses(
            ledgers : [Memory.Ledger],
            epoch : Nat,
        ) : async* NativeCounts {
            let pending = List.empty<NativeCall>();
            for (ledger in ledgers.vals()) {
                switch (Catalog.find(ledger.principal)) {
                    case null clearNativeAddressError(ledger);
                    case (?catalogLedger) {
                        switch (catalogLedger.native_route) {
                            case null clearNativeAddressError(ledger);
                            case (?route) {
                                switch (ChainKey.addressRequest(
                                    route,
                                    calls.canister_principal,
                                )) {
                                    case null clearNativeAddressError(ledger);
                                    case (?request) {
                                        switch (ledger.native_address) {
                                            case null List.add(pending, { ledger; request; route });
                                            case (?_) clearNativeAddressError(ledger);
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
            let operations = List.toArray(pending);
            if (operations.size() == 0) return emptyNativeCounts();
            let results = await* calls.call_batch(
                Array.map<NativeCall, Capabilities.CallRequest>(
                    operations,
                    func(operation) { operation.request },
                ),
            );
            if (mem.native_epoch != epoch) {
                return {
                    attempted = operations.size();
                    succeeded = 0;
                    failed = 0;
                    stale = operations.size();
                };
            };
            var succeeded = 0;
            var failed = 0;
            var index = 0;
            while (index < operations.size()) {
                let operation = operations[index];
                switch (ChainKey.decodeAddress(results[index])) {
                    case (#ok(address)) {
                        succeeded += 1;
                        updateNativeAddress(operation.ledger, address);
                    };
                    case (#err(error)) {
                        failed += 1;
                        updateNativeAddressError(operation.ledger, error);
                    };
                };
                index += 1;
            };
            {
                attempted = operations.size();
                succeeded;
                failed;
                stale = 0;
            };
        };

        func refreshNativeDeposits(
            ledgers : [Memory.Ledger],
            epoch : Nat,
        ) : async* NativeCounts {
            let pending = List.empty<NativeCall>();
            for (ledger in ledgers.vals()) {
                switch (Catalog.find(ledger.principal)) {
                    case null clearNativeRefreshError(ledger);
                    case (?catalogLedger) {
                        switch (catalogLedger.native_route) {
                            case null clearNativeRefreshError(ledger);
                            case (?route) {
                                switch (ChainKey.refreshRequest(
                                    route,
                                    calls.canister_principal,
                                )) {
                                    case null clearNativeRefreshError(ledger);
                                    case (?request) List.add(pending, { ledger; request; route });
                                };
                            };
                        };
                    };
                };
            };
            let operations = List.toArray(pending);
            if (operations.size() == 0) return emptyNativeCounts();
            let results = await* calls.call_batch(
                Array.map<NativeCall, Capabilities.CallRequest>(
                    operations,
                    func(operation) { operation.request },
                ),
            );
            if (mem.native_epoch != epoch) {
                return {
                    attempted = operations.size();
                    succeeded = 0;
                    failed = 0;
                    stale = operations.size();
                };
            };
            var succeeded = 0;
            var failed = 0;
            var index = 0;
            while (index < operations.size()) {
                let operation = operations[index];
                switch (ChainKey.decodeRefresh(operation.route, results[index])) {
                    case (#ok(progress)) {
                        succeeded += 1;
                        updateNativeRefresh(operation.ledger, operation.route, progress);
                    };
                    case (#err(error)) {
                        failed += 1;
                        updateNativeRefreshError(operation.ledger, error);
                    };
                };
                index += 1;
            };
            {
                attempted = operations.size();
                succeeded;
                failed;
                stale = 0;
            };
        };

        func refreshMetadata(ledgers : [Memory.Ledger]) : async* RefreshReport {
            mem.metadata_epoch += 1;
            let epoch = mem.metadata_epoch;
            var succeeded = 0;
            var failed = 0;
            var stale = 0;
            var offset = 0;
            label batches while (offset < ledgers.size()) {
                let size = min(BATCH_SIZE, ledgers.size() - offset);
                let batch = Array.tabulate<Memory.Ledger>(
                    size,
                    func(index) { ledgers[offset + index] },
                );
                let requests = Array.map<Memory.Ledger, Capabilities.CallRequest>(
                    batch,
                    func(ledger) { Icrc.metadataRequest(ledger.principal) },
                );
                let results = await* calls.call_batch(requests);
                if (mem.metadata_epoch != epoch) {
                    stale := ledgers.size() - offset;
                    break batches;
                };
                var index = 0;
                while (index < batch.size()) {
                    let ledger = batch[index];
                    switch (Icrc.decodeMetadata(results[index])) {
                        case (#err(error)) {
                            failed += 1;
                            updateMetadataError(ledger, error);
                        };
                        case (#ok(metadata)) {
                            switch (parseMetadata(metadata)) {
                                case (#err(error)) {
                                    failed += 1;
                                    updateMetadataError(ledger, error);
                                };
                                case (#ok(parsed)) {
                                    succeeded += 1;
                                    updateMetadata(ledger, parsed);
                                };
                            };
                        };
                    };
                    index += 1;
                };
                offset += size;
            };
            {
                attempted = ledgers.size();
                succeeded;
                failed;
                stale;
                snapshot = snapshot();
            };
        };

        func refreshBalances(ledgers : [Memory.Ledger]) : async* RefreshReport {
            mem.balance_epoch += 1;
            let epoch = mem.balance_epoch;
            var succeeded = 0;
            var failed = 0;
            var stale = 0;
            var offset = 0;
            label batches while (offset < ledgers.size()) {
                let size = min(BATCH_SIZE, ledgers.size() - offset);
                let batch = Array.tabulate<Memory.Ledger>(
                    size,
                    func(index) { ledgers[offset + index] },
                );
                let requests = Array.map<Memory.Ledger, Capabilities.CallRequest>(
                    batch,
                    func(ledger) {
                        Icrc.balanceRequest(ledger.principal, calls.canister_principal);
                    },
                );
                let results = await* calls.call_batch(requests);
                if (mem.balance_epoch != epoch) {
                    stale := ledgers.size() - offset;
                    break batches;
                };
                var index = 0;
                while (index < batch.size()) {
                    let ledger = batch[index];
                    switch (Icrc.decodeBalance(results[index])) {
                        case (#err(error)) {
                            failed += 1;
                            updateBalanceError(ledger, error);
                        };
                        case (#ok(balance)) {
                            succeeded += 1;
                            updateBalance(ledger, balance);
                        };
                    };
                    index += 1;
                };
                offset += size;
            };
            {
                attempted = ledgers.size();
                succeeded;
                failed;
                stale;
                snapshot = snapshot();
            };
        };

        func updateMetadata(ledger : Memory.Ledger, parsed : ParsedMetadata) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    name = prefer(parsed.name, current.name);
                    symbol = prefer(parsed.symbol, current.symbol);
                    decimals = prefer(parsed.decimals, current.decimals);
                    fee = prefer(parsed.fee, current.fee);
                    logo = prefer(parsed.logo, current.logo);
                    metadata_updated_at = ?Time.now();
                    metadata_error = null;
                };
            });
        };

        func updateMetadataError(ledger : Memory.Ledger, error : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    metadata_error = ?boundedText(error, 512);
                };
            });
        };

        func updateBalance(ledger : Memory.Ledger, balance : Nat) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    balance = ?balance;
                    balance_updated_at = ?Time.now();
                    balance_error = null;
                };
            });
        };

        func updateBalanceError(ledger : Memory.Ledger, error : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    balance_error = ?boundedText(error, 512);
                };
            });
        };

        func updateNativeAddress(ledger : Memory.Ledger, address : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_address = ?address;
                    native_address_updated_at = ?Time.now();
                    native_address_error = null;
                };
            });
        };

        func updateNativeAddressError(ledger : Memory.Ledger, error : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_address_error = ?boundedText(error, 512);
                };
            });
        };

        func clearNativeAddressError(ledger : Memory.Ledger) : () {
            if (ledger.native_address_error == null) return;
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_address_error = null;
                };
            });
        };

        func nativeDepositProgress(
            value : ChainKey.UtxoRefreshProgress,
            previous : ?Memory.NativeDepositProgress,
            now : Int,
        ) : Memory.NativeDepositProgress {
            {
                checked_at = now;
                current_confirmations = if (value.pending_complete) {
                    value.current_confirmations;
                } else switch (previous) {
                    case null value.current_confirmations;
                    case (?old) old.current_confirmations;
                };
                required_confirmations = if (value.pending_complete) {
                    value.required_confirmations;
                } else switch (previous) {
                    case null value.required_confirmations;
                    case (?old) old.required_confirmations;
                };
                pending = mergePendingDeposits(value, previous);
                processing = Array.map<ChainKey.ProcessingDeposit, Memory.NativeProcessingDeposit>(
                    value.processing,
                    func(deposit) {
                        {
                            txid = deposit.txid;
                            vout = deposit.vout;
                            value = deposit.value;
                        };
                    },
                );
                recent_minted = mergeRecentMinted(value.minted, previous, now);
                issues = Array.map<ChainKey.DepositIssue, Memory.NativeDepositIssue>(
                    value.issues,
                    func(issue) {
                        {
                            txid = issue.txid;
                            vout = issue.vout;
                            value = issue.value;
                            kind = switch (issue.kind) {
                                case (#value_too_small) #value_too_small;
                                case (#tainted) #tainted;
                                case (#quarantined) #quarantined;
                            };
                            earliest_retry = issue.earliest_retry;
                        };
                    },
                );
            };
        };

        func mergePendingDeposits(
            value : ChainKey.UtxoRefreshProgress,
            previous : ?Memory.NativeDepositProgress,
        ) : [Memory.NativePendingDeposit] {
            let result = List.empty<Memory.NativePendingDeposit>();
            let replaced = Set.empty<Text>();
            for (deposit in value.processing.vals()) {
                Set.add(replaced, Text.compare, depositKey(deposit.txid, deposit.vout));
            };
            for (deposit in value.minted.vals()) {
                Set.add(replaced, Text.compare, depositKey(deposit.txid, deposit.vout));
            };
            for (issue in value.issues.vals()) {
                Set.add(replaced, Text.compare, depositKey(issue.txid, issue.vout));
            };
            for (deposit in value.pending.vals()) {
                if (List.size(result) < DEPOSIT_PROGRESS_LIMIT) {
                    let next : Memory.NativePendingDeposit = {
                        txid = deposit.txid;
                        vout = deposit.vout;
                        value = deposit.value;
                        confirmations = deposit.confirmations;
                        required_confirmations = deposit.required_confirmations;
                    };
                    List.add(result, next);
                    Set.add(replaced, Text.compare, depositKey(deposit.txid, deposit.vout));
                };
            };
            if (not value.pending_complete) {
                switch (previous) {
                    case null {};
                    case (?old) {
                        for (deposit in old.pending.vals()) {
                            if (
                                List.size(result) < DEPOSIT_PROGRESS_LIMIT and
                                not Set.contains(
                                    replaced,
                                    Text.compare,
                                    depositKey(deposit.txid, deposit.vout),
                                )
                            ) {
                                List.add(result, deposit);
                            };
                        };
                    };
                };
            };
            List.toArray(result);
        };

        func mergeRecentMinted(
            minted : [ChainKey.MintedDeposit],
            previous : ?Memory.NativeDepositProgress,
            now : Int,
        ) : [Memory.NativeMintedDeposit] {
            let result = List.empty<Memory.NativeMintedDeposit>();
            let seen = Set.empty<Text>();
            for (deposit in minted.vals()) {
                if (List.size(result) < RECENT_MINTED_LIMIT) {
                    let key = depositKey(deposit.txid, deposit.vout);
                    if (Set.insert(seen, Text.compare, key)) {
                        List.add(result, {
                            txid = deposit.txid;
                            vout = deposit.vout;
                            value = deposit.value;
                            minted_amount = deposit.minted_amount;
                            block_index = deposit.block_index;
                            minted_at = now;
                        });
                    };
                };
            };
            switch (previous) {
                case null {};
                case (?old) {
                    for (deposit in old.recent_minted.vals()) {
                        if (List.size(result) < RECENT_MINTED_LIMIT) {
                            let key = depositKey(deposit.txid, deposit.vout);
                            if (Set.insert(seen, Text.compare, key)) {
                                List.add(result, deposit);
                            };
                        };
                    };
                };
            };
            List.toArray(result);
        };

        func depositKey(txid : Text, vout : Nat) : Text {
            txid # ":" # Nat.toText(vout);
        };

        func updateNativeRefresh(
            ledger : Memory.Ledger,
            route : Catalog.NativeRoute,
            progress : ?ChainKey.UtxoRefreshProgress,
        ) : () {
            let now = Time.now();
            switch (progress) {
                case null {};
                case (?value) {
                    for (deposit in value.minted.vals()) {
                        history.recordNativeMint(
                            ledger.principal,
                            deposit.block_index,
                            deposit.minted_amount,
                            {
                                network = Catalog.networkText(nativeRouteNetwork(route));
                                transaction_id = ?boundedText(deposit.txid, 128);
                                output_index = ?deposit.vout;
                                related_ledger = ?ledger.principal;
                                related_block_index = ?deposit.block_index;
                            },
                        );
                    };
                };
            };
            replaceLedger(ledger.id, ledger.principal, func(current) {
                let nextProgress = switch (progress) {
                    case null current.native_deposit_progress;
                    case (?value) ?nativeDepositProgress(
                        value,
                        current.native_deposit_progress,
                        now,
                    );
                };
                {
                    current with
                    native_refresh_updated_at = ?now;
                    native_refresh_error = null;
                    native_deposit_progress = nextProgress;
                };
            });
        };

        func updateNativeRefreshError(ledger : Memory.Ledger, error : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_refresh_error = ?boundedText(error, 512);
                };
            });
        };

        func clearNativeRefreshError(ledger : Memory.Ledger) : () {
            if (ledger.native_refresh_error == null) return;
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_refresh_error = null;
                };
            });
        };

        func depositReport(counts : NativeCounts) : DepositRefreshReport {
            {
                attempted = counts.attempted;
                succeeded = counts.succeeded;
                failed = counts.failed;
                stale = counts.stale;
                snapshot = snapshot();
            };
        };

        func replaceLedger(
            id : Nat,
            principal : Principal,
            update : Memory.Ledger -> Memory.Ledger,
        ) : () {
            let ?current = Map.get(mem.ledgers, Principal.compare, principal) else {
                return;
            };
            if (current.id != id) return;
            Map.add(mem.ledgers, Principal.compare, principal, update(current));
        };

        func newLedger(
            principal : Principal,
            catalogLedger : ?Catalog.Ledger,
        ) : Memory.Ledger {
            let name = switch (catalogLedger) {
                case null null;
                case (?ledger) ?ledger.name;
            };
            let symbol = switch (catalogLedger) {
                case null null;
                case (?ledger) ?ledger.symbol;
            };
            let source : Memory.HistorySource = switch (catalogLedger) {
                case null #unavailable;
                case (?ledger) switch (ledger.index) {
                    case null #unavailable;
                    case (?value) #index(Principal.fromText(value));
                };
            };
            {
                id = mem.next_id;
                principal;
                name;
                symbol;
                decimals = null;
                fee = null;
                logo = null;
                balance = null;
                metadata_updated_at = null;
                balance_updated_at = null;
                metadata_error = null;
                balance_error = null;
                native_address = null;
                native_address_updated_at = null;
                native_address_error = null;
                native_refresh_updated_at = null;
                native_refresh_error = null;
                native_deposit_progress = null;
                enabled = true;
                history = HistoryStore.emptyHistory(source);
            };
        };

        func setLedgerEnabled(ledger : Memory.Ledger, enabled : Bool) : () {
            if (ledger.enabled == enabled) return;
            ledger.history.config_epoch += 1;
            ledger.history.scan := null;
            ledger.history.state := #idle;
            ledger.history.last_error := null;
            Map.add(mem.ledgers, Principal.compare, ledger.principal, {
                ledger with enabled
            });
        };

        let _initializeDefaultLedgers : () = if (mem.configured) {
            ()
        } else {
            for (principalText in Catalog.defaultLedgers.vals()) {
                let principal = Principal.fromText(principalText);
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case (?ledger) setLedgerEnabled(ledger, true);
                    case null {
                        Map.add(
                            mem.ledgers,
                            Principal.compare,
                            principal,
                            newLedger(principal, Catalog.find(principal)),
                        );
                        mem.next_id += 1;
                    };
                };
            };
            mem.configured := true;
        };

        func enabledCustomLedgers() : [Memory.Ledger] {
            let custom = List.empty<Memory.Ledger>();
            for (ledger in Map.values(mem.ledgers)) {
                if (ledger.enabled) {
                    switch (Catalog.find(ledger.principal)) {
                        case null List.add(custom, ledger);
                        case (?_) {};
                    };
                };
            };
            Array.sort<Memory.Ledger>(
                List.toArray(custom),
                func(left, right) { Nat.compare(left.id, right.id) },
            );
        };

        func customLedgerHasHistory(ledger : Memory.Ledger) : Bool {
            Map.size(ledger.history.transactions) > 0 or
            Map.size(ledger.history.adjustments) > 0;
        };

        func retainedCustomLedgerCountAfter(
            requested : Set.Set<Principal>,
        ) : Nat {
            var count = 0;
            for (ledger in Map.values(mem.ledgers)) {
                switch (Catalog.find(ledger.principal)) {
                    case null {
                        if (
                            Set.contains(requested, Principal.compare, ledger.principal) or
                            customLedgerHasHistory(ledger)
                        ) count += 1;
                    };
                    case (?_) {};
                };
            };
            count;
        };

        func discardEmptyUnselectedCustomLedgers(
            requested : Set.Set<Principal>,
        ) : () {
            let discarded = List.empty<Principal>();
            for (ledger in Map.values(mem.ledgers)) {
                if (
                    not Set.contains(requested, Principal.compare, ledger.principal) and
                    not customLedgerHasHistory(ledger)
                ) {
                    switch (Catalog.find(ledger.principal)) {
                        case null List.add(discarded, ledger.principal);
                        case (?_) {};
                    };
                };
            };
            for (principal in List.values(discarded)) {
                Map.remove(mem.ledgers, Principal.compare, principal);
            };
        };

        func snapshot() : WalletSnapshot {
            let ledgers = List.empty<LedgerView>();
            for (catalogLedger in Catalog.ledgers.vals()) {
                let principal = Principal.fromText(catalogLedger.principal);
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case (?ledger) if (ledger.enabled) List.add(ledgers, ledger);
                    case null {};
                    case (_) {};
                };
            };
            for (ledger in enabledCustomLedgers().vals()) {
                List.add(ledgers, ledger);
            };
            {
                owner = calls.canister_principal;
                configured = mem.configured;
                ledgers = List.toArray(ledgers);
            };
        };

        func enabledLedgers() : [Memory.Ledger] {
            let result = List.empty<Memory.Ledger>();
            for (catalogLedger in Catalog.ledgers.vals()) {
                let principal = Principal.fromText(catalogLedger.principal);
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case (?ledger) if (ledger.enabled) List.add(result, ledger);
                    case (_) {};
                };
            };
            for (ledger in enabledCustomLedgers().vals()) {
                List.add(result, ledger);
            };
            List.toArray(result);
        };
    };

    func parseMetadata(metadata : IcrcTypes.Metadata) : IcrcTypes.Result<ParsedMetadata> {
        var name : ?Text = null;
        var symbol : ?Text = null;
        var decimals : ?Nat = null;
        var fee : ?Nat = null;
        var logo : ?Text = null;
        for ((key, value) in metadata.vals()) {
            if (key == "icrc1:name") {
                switch (value) {
                    case (#Text(text)) {
                        if (text.size() > 128) return #err("Ledger name is too long");
                        name := ?text;
                    };
                    case (_) return #err("Ledger name has an unexpected type");
                };
            } else if (key == "icrc1:symbol") {
                switch (value) {
                    case (#Text(text)) {
                        if (text.size() > 32) return #err("Ledger symbol is too long");
                        symbol := ?text;
                    };
                    case (_) return #err("Ledger symbol has an unexpected type");
                };
            } else if (key == "icrc1:decimals") {
                switch (value) {
                    case (#Nat(value)) {
                        if (value > 255) return #err("Ledger decimals are too large");
                        decimals := ?value;
                    };
                    case (_) return #err("Ledger decimals have an unexpected type");
                };
            } else if (key == "icrc1:fee") {
                switch (value) {
                    case (#Nat(value)) fee := ?value;
                    case (_) return #err("Ledger fee has an unexpected type");
                };
            } else if (key == "icrc1:logo") {
                switch (value) {
                    case (#Text(text)) {
                        if (Text.encodeUtf8(text).size() > 32_768) {
                            return #err("Ledger logo is too large");
                        };
                        logo := ?text;
                    };
                    case (_) return #err("Ledger logo has an unexpected type");
                };
            };
        };
        #ok({ name; symbol; decimals; fee; logo });
    };

    func commandKeyCompare(
        left : CommandMemory.CommandKey,
        right : CommandMemory.CommandKey,
    ) : Order.Order {
        switch (Text.compare(left.caller_app_id, right.caller_app_id)) {
            case (#equal) Blob.compare(left.request_id, right.request_id);
            case (order) order;
        };
    };

    func nowNanos() : Nat64 {
        Nat64.fromNat(Int.abs(Time.now()));
    };

    func min(left : Nat, right : Nat) : Nat {
        if (left < right) left else right;
    };

    func catalogRoute(route : Catalog.NativeRoute) : CatalogNativeRoute {
        switch (route) {
            case (#ckbtc(value)) {
                {
                    kind = "ckbtc";
                    origin_network = "bitcoin_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = null;
                    gas_ledger = null;
                    native_actions_available = true;
                };
            };
            case (#cketh(value)) {
                {
                    kind = "cketh";
                    origin_network = "ethereum_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = null;
                    gas_ledger = null;
                    native_actions_available = true;
                };
            };
            case (#ckerc20(value)) {
                {
                    kind = "ckerc20";
                    origin_network = "ethereum_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = ?value.contract;
                    gas_ledger = ?Principal.fromText(value.cketh_ledger);
                    native_actions_available = true;
                };
            };
            case (#ckdoge(value)) {
                {
                    kind = "ckdoge";
                    origin_network = "dogecoin_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = null;
                    gas_ledger = null;
                    native_actions_available = true;
                };
            };
            case (#cksol(value)) {
                {
                    kind = "cksol";
                    origin_network = "solana_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = null;
                    gas_ledger = null;
                    native_actions_available = true;
                };
            };
        };
    };

    func toCatalogNetwork(network : DestinationKindV1) : Catalog.Network {
        switch (network) {
            case (#internet_computer) #internet_computer;
            case (#bitcoin_mainnet) #bitcoin_mainnet;
            case (#dogecoin_mainnet) #dogecoin_mainnet;
            case (#ethereum_mainnet) #ethereum_mainnet;
            case (#solana_mainnet) #solana_mainnet;
        };
    };

    func validEthereumAddress(value : Text) : Bool {
        if (value.size() != 42) return false;
        let chars = value.chars();
        if (chars.next() != ?'0' or chars.next() != ?'x') return false;
        for (char in chars) {
            if (not (char >= '0' and char <= '9') and not (char >= 'a' and char <= 'f') and not (char >= 'A' and char <= 'F')) return false;
        };
        true;
    };

    func supportsNetwork(
        principal : Principal,
        network : DestinationKindV1,
    ) : Bool {
        switch (Catalog.find(principal)) {
            case (?ledger) Catalog.supportsNetwork(ledger, toCatalogNetwork(network));
            case null switch (network) {
                case (#internet_computer) true;
                case (_) false;
            };
        };
    };

    func accountsEqual(left : IcrcTypes.Account, right : IcrcTypes.Account) : Bool {
        left.owner == right.owner and left.subaccount == right.subaccount;
    };

    func destinationMatchesNetwork(
        destination : DestinationV1,
        network : DestinationKindV1,
    ) : Bool {
        switch (destination, network) {
            case (#internet_computer(_), #internet_computer) true;
            case (#bitcoin_mainnet(_), #bitcoin_mainnet) true;
            case (#dogecoin_mainnet(_), #dogecoin_mainnet) true;
            case (#ethereum_mainnet(_), #ethereum_mainnet) true;
            case (#solana_mainnet(_), #solana_mainnet) true;
            case (_) false;
        };
    };

    func destinationsEqual(left : DestinationV1, right : DestinationV1) : Bool {
        switch (left, right) {
            case (#internet_computer(leftAccount), #internet_computer(rightAccount)) {
                accountsEqual(leftAccount, rightAccount);
            };
            case (#bitcoin_mainnet(leftAddress), #bitcoin_mainnet(rightAddress)) {
                leftAddress == rightAddress;
            };
            case (#dogecoin_mainnet(leftAddress), #dogecoin_mainnet(rightAddress)) {
                leftAddress == rightAddress;
            };
            case (#ethereum_mainnet(leftAddress), #ethereum_mainnet(rightAddress)) {
                leftAddress == rightAddress;
            };
            case (#solana_mainnet(leftAddress), #solana_mainnet(rightAddress)) {
                leftAddress == rightAddress;
            };
            case (_) false;
        };
    };

    func nativeAddress(destination : DestinationV1) : IcrcTypes.Result<Text> {
        switch (destination) {
            case (#internet_computer(_)) #err("Contact destination is not a native address");
            case (#bitcoin_mainnet(address)) #ok(address);
            case (#dogecoin_mainnet(address)) #ok(address);
            case (#ethereum_mainnet(address)) #ok(address);
            case (#solana_mainnet(address)) #ok(address);
        };
    };

    func destinationText(destination : DestinationV1) : Text {
        switch (destination) {
            case (#internet_computer(account)) {
                Principal.toText(account.owner) # (switch (account.subaccount) {
                    case null "";
                    case (?value) ":" # blobHex(value);
                });
            };
            case (#bitcoin_mainnet(address)) address;
            case (#dogecoin_mainnet(address)) address;
            case (#ethereum_mainnet(address)) address;
            case (#solana_mainnet(address)) address;
        };
    };

    func blobHex(value : Blob) : Text {
        let digits = [
            "0", "1", "2", "3", "4", "5", "6", "7",
            "8", "9", "a", "b", "c", "d", "e", "f",
        ];
        var result = "";
        var count = 0;
        for (byte in value.vals()) {
            if (count < 32) {
                let number = Nat8.toNat(byte);
                result #= digits[number / 16] # digits[number % 16];
                count += 1;
            };
        };
        result;
    };

    func nativeRouteNetwork(route : Catalog.NativeRoute) : Catalog.Network {
        switch (route) {
            case (#ckbtc(_)) #bitcoin_mainnet;
            case (#ckdoge(_)) #dogecoin_mainnet;
            case (#cketh(_)) #ethereum_mainnet;
            case (#ckerc20(_)) #ethereum_mainnet;
            case (#cksol(_)) #solana_mainnet;
        };
    };

    func contactErrorText(error : ContactErrorV1) : Text {
        switch (error) {
            case (#validation(message)) message;
            case (#limit(message)) message;
            case (#not_found(id)) "Contact " # Nat.toText(id) # " was not found";
            case (#conflict(value)) {
                "Contact revision conflict: expected " # Nat.toText(value.expected) #
                ", current " # Nat.toText(value.actual)
            };
        };
    };

    func prefer<T>(next : ?T, current : ?T) : ?T {
        switch (next) {
            case (?value) ?value;
            case (null) current;
        };
    };

    func boundedText(value : Text, limit : Nat) : Text {
        if (value.size() <= limit) return value;
        Text.fromIter(Iter.take(value.chars(), limit));
    };

    func emptyNativeCounts() : NativeCounts {
        {
            attempted = 0;
            succeeded = 0;
            failed = 0;
            stale = 0;
        };
    };

    func addNativeCounts(left : NativeCounts, right : NativeCounts) : NativeCounts {
        {
            attempted = left.attempted + right.attempted;
            succeeded = left.succeeded + right.succeeded;
            failed = left.failed + right.failed;
            stale = left.stale + right.stale;
        };
    };

/*---NEUTRON GENERATED BEGIN---*/

public type wallet_read_v1_Input = (request : WalletReadRequestV1);
public type wallet_read_v1_Output = WalletReadResultV1;

public type wallet_refill_action_v1_Input = (request : WalletRefillActionV1);
public type wallet_refill_action_v1_Output = WalletRefillResultV1;

public type wallet_refill_prepare_v1_Input = (request : WalletRefillRequestV1);
public type wallet_refill_prepare_v1_Output = WalletRefillResultV1;

public type wallet_refill_execute_v1_Input = (id : Blob);
public type wallet_refill_execute_v1_Output = WalletRefillResultV1;

public type wallet_refill_continue_v1_Input = (id : Blob);
public type wallet_refill_continue_v1_Output = WalletRefillResultV1;

public type wallet_refill_status_v1_Input = (id : Blob);
public type wallet_refill_status_v1_Output = WalletRefillResultV1;

public type wallet_snapshot_Input = (());
public type wallet_snapshot_Output = WalletSnapshot;

public type wallet_catalog_Input = (());
public type wallet_catalog_Output = [CatalogLedger];

public type wallet_history_page_Input = (request : WalletHistoryPageRequest,);
public type wallet_history_page_Output = WalletHistoryPage;

public type wallet_history_status_Input = (());
public type wallet_history_status_Output = WalletHistoryStatus;

public type wallet_history_sources_Input = (());
public type wallet_history_sources_Output = [WalletHistorySourceStatus];

public type wallet_history_sync_Input = (());
public type wallet_history_sync_Output = WalletHistorySyncReport;

public type wallet_history_tick_Input = (());
public type wallet_history_tick_Output = ();

public type wallet_contact_destinations_Input = (request : WalletContactDestinationsRequest,);
public type wallet_contact_destinations_Output = WalletContactDestinationsResult;

public type wallet_transfer_Input = (request : WalletTransferRequest,);
public type wallet_transfer_Output = WalletTransferResult;

public type wallet_withdrawal_quote_v1_Input = (request : WalletWithdrawalQuoteRequestV1);
public type wallet_withdrawal_quote_v1_Output = WalletWithdrawalQuoteResultV1;

public type wallet_transfer_v2_Input = (request : WalletTransferRequestV2);
public type wallet_transfer_v2_Output = WalletTransferResultV2;

public type wallet_transfer_prepare_v2_Input = (request : WalletTransferRequestV2);
public type wallet_transfer_prepare_v2_Output = WalletTransferResultV2;

public type wallet_ethereum_withdraw_prepare_v1_Input = (request : WalletEthereumWithdrawRequestV1);
public type wallet_ethereum_withdraw_prepare_v1_Output = WalletTransferResultV2;

public type wallet_ethereum_withdraw_status_v1_Input = (id : Blob);
public type wallet_ethereum_withdraw_status_v1_Output = WalletEthereumWithdrawStatusResultV1;

public type wallet_transfer_resume_v2_Input = (id : Blob);
public type wallet_transfer_resume_v2_Output = WalletTransferResultV2;

public type wallet_transfer_status_v2_Input = (id : Blob);
public type wallet_transfer_status_v2_Output = WalletTransferResultV2;

public type wallet_transfers_pending_v2_Input = (());
public type wallet_transfers_pending_v2_Output = [WalletTransferOperationV2];

public type wallet_transfer_acknowledge_v2_Input = (id : Blob);
public type wallet_transfer_acknowledge_v2_Output = WalletTransferResultV2;

public type wallet_transfer_refresh_v2_Input = (id : Blob);
public type wallet_transfer_refresh_v2_Output = WalletTransferResultV2;

public type wallet_bridge_quote_v1_Input = (ledger : Principal);
public type wallet_bridge_quote_v1_Output = WalletBridgeQuoteResultV1;

public type wallet_bridge_prepare_v1_Input = (request : WalletBridgePrepareRequestV1);
public type wallet_bridge_prepare_v1_Output = WalletBridgeIntentResultV1;

public type wallet_bridge_provider_binding_v1_Input = (id : Blob);
public type wallet_bridge_provider_binding_v1_Output = WalletBridgeProviderBindingResultV1;

public type wallet_bridge_provider_prepare_v1_Input = (request : WalletBridgeProviderPrepareRequestV1);
public type wallet_bridge_provider_prepare_v1_Output = WalletBridgeIntentResultV1;

public type wallet_bridge_list_v1_Input = (request : WalletBridgeListRequestV1);
public type wallet_bridge_list_v1_Output = WalletBridgePageV1;

public type wallet_bridge_status_v1_Input = (id : Blob);
public type wallet_bridge_status_v1_Output = WalletBridgeIntentResultV1;

public type wallet_bridge_activity_v1_Input = (request : WalletBridgeActivityRequestV1);
public type wallet_bridge_activity_v1_Output = WalletBridgeActivityResultV1;

public type wallet_bridge_step_v2_Input = (request : WalletBridgeStepActionV2);
public type wallet_bridge_step_v2_Output = WalletBridgeIntentResultV1;

public type wallet_bridge_claim_v1_Input = (request : WalletBridgeClaimRequestV1);
public type wallet_bridge_claim_v1_Output = WalletBridgeIntentResultV1;

public type wallet_bridge_record_step_v1_Input = (request : WalletBridgeRecordStepRequestV1);
public type wallet_bridge_record_step_v1_Output = WalletBridgeIntentResultV1;

public type wallet_bridge_replacement_v1_Input = (request : WalletBridgeReplacementActionV1);
public type wallet_bridge_replacement_v1_Output = WalletBridgeReplacementResultV1;

public type wallet_bridge_refresh_v1_Input = (request : WalletBridgeRefreshRequestV1);
public type wallet_bridge_refresh_v1_Output = WalletBridgeIntentResultV1;

public type wallet_funding_prepare_v1_Input = (request : WalletFundingPrepareRequestV1,);
public type wallet_funding_prepare_v1_Output = WalletFundingPrepareResultV1;

public type wallet_funding_execute_v1_Input = (request : WalletFundingExecuteRequestV1,);
public type wallet_funding_execute_v1_Output = WalletFundingExecutionResultV1;

public type wallet_funding_reject_v1_Input = (request : WalletFundingExecuteRequestV1,);
public type wallet_funding_reject_v1_Output = WalletFundingExecutionResultV1;

public type wallet_allowances_page_v1_Input = (request : WalletAllowancesPageRequestV1,);
public type wallet_allowances_page_v1_Output = WalletAllowancesPageResultV1;

public type wallet_token_info_v1_Input = (request : WalletTokenInfoRequestV1,);
public type wallet_token_info_v1_Output = WalletTokenInfoResultV1;

public type wallet_add_ledger_v1_Input = (principal : Principal,);
public type wallet_add_ledger_v1_Output = WalletSnapshot;

public type wallet_set_ledgers_Input = (principals : [Principal],);
public type wallet_set_ledgers_Output = WalletSnapshot;

public type wallet_refresh_metadata_Input = (());
public type wallet_refresh_metadata_Output = RefreshReport;

public type wallet_refresh_balances_Input = (());
public type wallet_refresh_balances_Output = RefreshReport;

public type wallet_refresh_deposits_Input = (());
public type wallet_refresh_deposits_Output = DepositRefreshReport;

/*---NEUTRON GENERATED END---*/
};

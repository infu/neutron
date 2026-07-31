// The lineage migration deliberately retains every V1 map by reference. The
// new plaintext plane starts with only its two fixed root folders.
import V1 "./v1";
import V2 "./v2";

module {
    public func migrate(old : V1.Mem) : V2.Mem {
        let fresh = V2.init();
        {
            var next_stage_id = old.next_stage_id;
            var next_job_id = old.next_job_id;
            var next_share_id = old.next_share_id;
            var share_list_revision = old.share_list_revision;

            var vault = old.vault;
            nodes_by_id = old.nodes_by_id;
            children_by_name = old.children_by_name;
            blocks = old.blocks;
            stages = old.stages;
            stages_by_request = old.stages_by_request;
            private_receipts = old.private_receipts;
            private_receipts_by_expiry = old.private_receipts_by_expiry;
            private_receipt_identity_owners =
                old.private_receipt_identity_owners;
            delete_jobs = old.delete_jobs;
            share_lifecycle_by_id = old.share_lifecycle_by_id;
            share_by_publish_request = old.share_by_publish_request;
            share_by_delete_request = old.share_by_delete_request;
            share_lifecycle_by_expiry = old.share_lifecycle_by_expiry;
            public_terminal_receipts = old.public_terminal_receipts;
            public_terminal_by_expiry = old.public_terminal_by_expiry;

            var node_count = old.node_count;
            var committed_private_plaintext_bytes =
                old.committed_private_plaintext_bytes;
            var committed_ciphertext_bytes = old.committed_ciphertext_bytes;
            var staged_ciphertext_bytes = old.staged_ciphertext_bytes;
            var reserved_staged_ciphertext_bytes =
                old.reserved_staged_ciphertext_bytes;
            var physical_private_bytes = old.physical_private_bytes;
            var reserved_physical_private_bytes =
                old.reserved_physical_private_bytes;
            var reserved_cleanup_jobs = old.reserved_cleanup_jobs;

            var next_plain_node_id = fresh.next_plain_node_id;
            var next_plain_content_id = fresh.next_plain_content_id;
            var next_plain_stage_id = fresh.next_plain_stage_id;
            workspace_root_id = fresh.workspace_root_id;
            shared_root_id = fresh.shared_root_id;
            plain_nodes = fresh.plain_nodes;
            plain_children = fresh.plain_children;
            plain_blocks = fresh.plain_blocks;
            plain_stages = fresh.plain_stages;
            plain_stage_by_request = fresh.plain_stage_by_request;
            plain_terminal_receipts = fresh.plain_terminal_receipts;
            var workspace_plaintext_bytes = 0;
            var shared_plaintext_bytes = 0;
            var shared_file_count = 0;
            var staged_workspace_bytes = 0;
        };
    };
};

import List "mo:core/List";
import Memory "../memory/files/v1";

module {
    public type Identities = {
        node_ids : [Memory.Id128];
        content_ids : [Memory.Id128];
        // Union of both namespaces. Each value names one stable index row.
        row_ids : [Memory.Id128];
    };

    func contains(
        values : List.List<Memory.Id128>,
        wanted : Memory.Id128,
    ) : Bool {
        for (value in List.toArray(values).values()) {
            if (value == wanted) return true;
        };
        false;
    };

    func addUnique(
        values : List.List<Memory.Id128>,
        value : Memory.Id128,
    ) {
        if (not contains(values, value)) {
            List.add(values, value);
        };
    };

    func addNode(
        nodes : List.List<Memory.Id128>,
        rows : List.List<Memory.Id128>,
        nodeId : Memory.Id128,
    ) {
        addUnique(nodes, nodeId);
        addUnique(rows, nodeId);
    };

    func addContent(
        contents : List.List<Memory.Id128>,
        rows : List.List<Memory.Id128>,
        contentId : Memory.Id128,
    ) {
        addUnique(contents, contentId);
        addUnique(rows, contentId);
    };

    func finish(
        nodes : List.List<Memory.Id128>,
        contents : List.List<Memory.Id128>,
        rows : List.List<Memory.Id128>,
    ) : Identities {
        {
            node_ids = List.toArray(nodes);
            content_ids = List.toArray(contents);
            row_ids = List.toArray(rows);
        };
    };

    public func receipt(
        value : Memory.PrivateReceipt
    ) : Identities {
        let nodes = List.empty<Memory.Id128>();
        let contents = List.empty<Memory.Id128>();
        let rows = List.empty<Memory.Id128>();
        switch (value.outcome) {
            case (#vault(_)) {};
            case (#write(outcome)) {
                for (node in outcome.nodes.values()) {
                    addNode(nodes, rows, node.node_id);
                    switch (node.content_id) {
                        case null {};
                        case (?contentId) {
                            addContent(contents, rows, contentId);
                        };
                    };
                };
            };
            case (#mutation(outcome)) {
                addNode(nodes, rows, outcome.node_id);
            };
            case (#remove(outcome)) {
                addNode(nodes, rows, outcome.node_id);
            };
            case (#abort(outcome)) {
                for (node in outcome.nodes.values()) {
                    addNode(nodes, rows, node.node_id);
                    switch (node.content_id) {
                        case null {};
                        case (?contentId) {
                            addContent(contents, rows, contentId);
                        };
                    };
                };
            };
            case (#expired(outcome)) {
                for (node in outcome.nodes.values()) {
                    addNode(nodes, rows, node.node_id);
                    switch (node.content_id) {
                        case null {};
                        case (?contentId) {
                            addContent(contents, rows, contentId);
                        };
                    };
                };
            };
        };
        finish(nodes, contents, rows);
    };

    // Write completion and private-stage expiry retain the same explicit
    // targets: newly created nodes and nodes whose metadata revision changes.
    public func stage(
        value : Memory.PrivateStage
    ) : Identities {
        let nodes = List.empty<Memory.Id128>();
        let contents = List.empty<Memory.Id128>();
        let rows = List.empty<Memory.Id128>();
        for (mutation in value.commit_plan.node_mutations.values()) {
            switch (mutation.replacement) {
                case null {};
                case (?replacement) {
                    let explicit = switch (mutation.expected) {
                        case null true;
                        case (?expected) {
                            expected.metadata_revision !=
                                replacement.metadata_revision;
                        };
                    };
                    if (explicit) {
                        addNode(nodes, rows, mutation.node_id);
                        switch (replacement.kind) {
                            case (#folder(_)) {};
                            case (#file(file)) switch (
                                file.active_content
                            ) {
                                case null {};
                                case (?content) {
                                    addContent(
                                        contents,
                                        rows,
                                        content.content_id,
                                    );
                                };
                            };
                        };
                    };
                };
            };
        };
        finish(nodes, contents, rows);
    };
};

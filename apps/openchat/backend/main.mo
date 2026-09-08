// OpenChat is a browser-side client of the third-party OpenChat network.
// This app deliberately holds no backend state: all chat state and the app's
// OpenChat delegation live in the resident background's browser storage, and
// every OpenChat call is a direct browser ingress signed by the app-held key.
// The backend is therefore an empty module with no managed memory, no
// capabilities, and no exposed methods.
module {

    public class Init() {};

    /*---NEUTRON GENERATED BEGIN---*/

/*---NEUTRON GENERATED END---*/
}

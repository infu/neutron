import Contacts "../../backend/main";
import Memory "../../backend/memory/contacts/v2";

let contacts = Contacts.Init({
    stable_memory = {
        contacts = Memory.init();
    };
});
ignore contacts.contacts_revision(());

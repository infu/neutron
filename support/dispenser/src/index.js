import { createRoot } from "react-dom/client";

import "./style.scss";

const container = document.getElementById("root");
const root = createRoot(container);

const App = () => {
  return <div className="app">Neutron Dispenser</div>;
};

root.render(<App />);

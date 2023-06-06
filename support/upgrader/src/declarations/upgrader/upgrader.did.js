export const idlFactory = ({ IDL }) => {
  return IDL.Service({
    'upgrade' : IDL.Func([IDL.Vec(IDL.Nat8), IDL.Principal], [], []),
  });
};
export const init = ({ IDL }) => { return []; };

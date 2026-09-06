// SPDX-License-Identifier: LicenseRef-Neutron-Sovereign-Application-Use-License-1.0
pragma solidity 0.8.20;

/// @notice Local ERC-20 protocol test asset; not Circle's USDC implementation.
/// @dev Uses USDT-style zero-before-nonzero approval changes to exercise reset
///      recovery. Initialize once after installing runtime at the local address.
contract ProtocolToken {
    string public constant name = "Local protocol USDC fixture";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    address public owner;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function init(address initialOwner) external {
        require(owner == address(0), "Already initialized");
        require(initialOwner != address(0), "Owner is zero address");
        owner = initialOwner;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "Only owner can mint");
        require(to != address(0), "Recipient is zero address");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(spender != address(0), "Spender is zero address");
        require(amount == 0 || allowance[msg.sender][spender] == 0, "Reset allowance to zero first");
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "Insufficient allowance");
            uint256 remainingAllowance = currentAllowance - amount;
            allowance[from][msg.sender] = remainingAllowance;
            emit Approval(from, msg.sender, remainingAllowance);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0), "Sender is zero address");
        require(to != address(0), "Recipient is zero address");
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

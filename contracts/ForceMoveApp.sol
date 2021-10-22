pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "@statechannels/nitro-protocol/contracts/interfaces/IForceMoveApp.sol";
import "hardhat/console.sol";

contract Scorched is IForceMoveApp {
  function validTransition(
    VariablePart memory a,
    VariablePart memory b,
    uint48 turnNumB,
    uint256 nParticipants
  ) public pure override returns (bool) {
    return true;
  }
}

async function loadUser(db, id) {
  return db.findUser(id);
}

async function handleRequest(db, id, res) {
  const user = loadUser(db, id);
  res.json(user);
}

module.exports = { handleRequest, loadUser };

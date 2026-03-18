<?php
$db=getenv("DATABASE_URL");
$conn=pg_connect($db);
$res=pg_query($conn,"SELECT * FROM jarvis_app_config");

echo "<h2>Config DB</h2>";
echo "<table>";

while($r=pg_fetch_assoc($res)){
echo "<tr>";
echo "<td>".$r['config_key']."</td>";
echo "<td>".$r['config_value']."</td>";
echo "</tr>";
}

echo "</table>";
?>
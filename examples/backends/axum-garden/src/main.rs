#[tokio::main]
async fn main() {
    let address = std::env::var("ADDRESS").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&address).await.expect("bind");
    println!("Garden plots on http://{address}");
    axum::serve(listener, axum_garden::app())
        .await
        .expect("serve");
}

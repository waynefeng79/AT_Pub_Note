from typing import Annotated

from fastapi import APIRouter, Depends, Response
from app.api.deps import current_db_user, get_conn
from app.db.session import DbConnection
from app.models import FavouriteRoutesRequest
from app.repositories.users import UserRepository

router = APIRouter()


@router.get("/favourite-routes")
def get_favourites(user: Annotated[dict, Depends(current_db_user)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {"route_ids": UserRepository(conn).favourite_routes(user["id"])}


@router.put("/favourite-routes")
def put_favourites(body: FavouriteRoutesRequest, user: Annotated[dict, Depends(current_db_user)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    route_ids = UserRepository(conn).replace_favourites(user["id"], body.route_ids)
    conn.commit()
    return {"route_ids": route_ids}


@router.post("/favourite-routes/{route_id}")
def add_favourite(route_id: str, user: Annotated[dict, Depends(current_db_user)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    route_ids = UserRepository(conn).add_favourite(user["id"], route_id)
    conn.commit()
    return {"route_ids": route_ids}


@router.delete("/favourite-routes/{route_id}")
def delete_favourite(route_id: str, user: Annotated[dict, Depends(current_db_user)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    route_ids = UserRepository(conn).remove_favourite(user["id"], route_id)
    conn.commit()
    return {"route_ids": route_ids}
